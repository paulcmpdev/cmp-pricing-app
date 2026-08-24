/**
 * SanMar SOAP catalog adapter.
 *
 * Completeness strategy:
 * 1. Start with every style ID in the active CMP catalog.
 * 2. Discover new/changed IDs with PromoStandards getProductDateModified.
 * 3. Fetch every resulting style with getProductInfoByStyleColorSize (style only),
 *    which returns all current variants plus piece/dozen/case pricing.
 * 4. Exclude a style only when its isolated style request succeeds with zero
 *    product rows. Any fault, vendor error, malformed row, partial/unpriced row,
 *    conflicting duplicate, or discovery failure rejects the whole manifest.
 *
 * Inventory is intentionally unknown. The validated Vendo snapshot also has no
 * SanMar inventory values. A separate inventory/SFTP source can add it later.
 */

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { ErrorCategory, createSourceError } from './contracts.mjs';
import { abortableSleep, withRetry } from './retry.mjs';

const SANMAR_ORIGIN = 'https://ws.sanmar.com:8080';
const PRODUCT_INFO_URL = `${SANMAR_ORIGIN}/SanMarWebService/SanMarProductInfoServicePort`;
const PRODUCT_DATA_URL = `${SANMAR_ORIGIN}/promostandards/ProductDataServiceBindingV2`;
const SOAP_ENVELOPE_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/';
const PRODUCT_INFO_NAMESPACE = 'http://impl.webservice.integration.sanmar.com/';
const PRODUCT_DATA_NAMESPACE = 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const DEFAULT_REQUEST_DELAY_MS = 250;
const DEFAULT_WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  allowBooleanAttributes: false,
});

const namespaceParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  allowBooleanAttributes: false,
});

export function parseSanMarProductInfoResponse(xml, { styleId, brand, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const label = safeLabel(styleId ?? brand);
  const document = parseSoapXml(xml, {
    label,
    maxResponseBytes,
    expectedOperation: 'getProductInfoByStyleColorSizeResponse',
    expectedNamespace: PRODUCT_INFO_NAMESPACE,
  });
  const response = requireSoapOperation(document, label, 'getProductInfoByStyleColorSizeResponse');
  const result = response.return;
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} is missing the return object`);
  }
  const errorFlag = text(result.errorOccured ?? result.errorOccurred).toLowerCase();
  if (errorFlag !== 'false') {
    const message = text(result.message);
    const error = sourceError(
      /authenticat/i.test(message) ? ErrorCategory.AUTH : ErrorCategory.SERVER,
      `SanMar reported an error for ${label}`
    );
    error.sanmarErrorKind = 'product_info_error';
    throw error;
  }

  const stylesById = new Map();
  const variantsById = new Map();
  for (const [index, row] of toArray(result.listResponse).entries()) {
    const normalized = normalizeProductRow(row, { label, index });
    if (styleId && normalized.style.sourceStyleId.toLowerCase() !== String(styleId).toLowerCase()) {
      throw sourceError(
        ErrorCategory.VALIDATION,
        `SanMar style request for ${label} returned unexpected style ${safeLabel(normalized.style.sourceStyleId)}`
      );
    }
    addConsistent(stylesById, normalized.style.sourceStyleId, normalized.style, styleIdentity, 'style');
    addConsistent(variantsById, normalized.variant.sourceVariantId, normalized.variant, variantIdentity, 'variant');
  }

  return {
    styles: Array.from(stylesById.values()),
    variants: Array.from(variantsById.values()),
    message: text(result.message) || undefined,
    responseBytes: Buffer.byteLength(xml, 'utf8'),
  };
}

export function parseSanMarDateModifiedResponse(xml, { maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const label = 'date-modified discovery';
  const document = parseSoapXml(xml, {
    label,
    maxResponseBytes,
    expectedOperation: 'GetProductDateModifiedResponse',
    expectedNamespace: PRODUCT_DATA_NAMESPACE,
  });
  const response = requireSoapOperation(document, label, 'GetProductDateModifiedResponse');
  const serviceMessages = findAllByKey(response, 'ServiceMessage');
  if (serviceMessages.length > 0) {
    throw sourceError(ErrorCategory.SERVER, 'SanMar date-modified response contained service messages');
  }
  const array = response.ProductDateModifiedArray;
  if (array == null) return [];
  const records = toArray(array.ProductDateModified);
  const ids = new Set();
  for (const [index, record] of records.entries()) {
    if (record == null || typeof record !== 'object' || Array.isArray(record)) {
      throw sourceError(ErrorCategory.SCHEMA, `SanMar date-modified row ${index} is malformed`);
    }
    const productId = requiredText(record.productId, 'productId', label, index);
    ids.add(productId);
  }
  return Array.from(ids).sort();
}

export function parseSanMarProductLookupResponse(xml, { styleId, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const label = safeLabel(styleId);
  const document = parseSoapXml(xml, {
    label,
    maxResponseBytes,
    expectedOperation: 'GetProductResponse',
    expectedNamespace: PRODUCT_DATA_NAMESPACE,
  });
  const response = requireSoapOperation(document, label, 'GetProductResponse');
  const product = response.Product;
  const messages = findAllByKey(response, 'ServiceMessage');
  if (product != null) {
    if (messages.length > 0) {
      throw sourceError(
        ErrorCategory.SERVER,
        `SanMar Product Data returned conflicting product and service messages for ${label}`
      );
    }
    if (typeof product !== 'object' || Array.isArray(product)) {
      throw sourceError(ErrorCategory.SCHEMA, `SanMar Product Data response for ${label} has a malformed Product`);
    }
    const returnedId = requiredText(product.productId, 'productId', label, 0);
    if (returnedId.toLowerCase() !== String(styleId).toLowerCase()) {
      throw sourceError(
        ErrorCategory.VALIDATION,
        `SanMar Product Data request for ${label} returned unexpected product ${safeLabel(returnedId)}`
      );
    }
    return { found: true };
  }

  if (messages.length === 1) {
    const message = messages[0];
    if (message != null && typeof message === 'object' && !Array.isArray(message)) {
      const code = text(message.code);
      const severity = text(message.severity).toLowerCase();
      const description = text(message.description).toLowerCase();
      if (code === '130' && severity === 'error' && description === 'product id not found') {
        return { found: false };
      }
    }
  }
  throw sourceError(
    ErrorCategory.SERVER,
    `SanMar Product Data could not confirm whether ${label} exists`
  );
}

export function createSanMarSoapSource({
  customerNumber,
  username,
  password,
  styleIds,
  since,
  fetch: fetchFn = globalThis.fetch,
  sleep,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  now = () => new Date(),
  watermarkOverlapMs = DEFAULT_WATERMARK_OVERLAP_MS,
} = {}) {
  if (!customerNumber || !username || !password) {
    throw new Error('SanMar SOAP credentials (customerNumber, username, password) are required');
  }
  if (!Array.isArray(styleIds) || styleIds.some((id) => !text(id))) {
    throw new Error('SanMar SOAP styleIds must be an array of non-empty strings');
  }
  const normalizedSince = normalizeSince(since);
  if (typeof fetchFn !== 'function') throw new Error('SanMar SOAP fetch implementation is required');
  assertPositiveSafeInteger(timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  assertPositiveSafeInteger(maxResponseBytes, 'maxResponseBytes', MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 60_000) {
    throw new Error('SanMar SOAP requestDelayMs must be an integer from 0 through 60000');
  }
  if (typeof now !== 'function') throw new Error('SanMar SOAP now must be a function');
  if (!Number.isSafeInteger(watermarkOverlapMs) || watermarkOverlapMs < 0) {
    throw new Error('SanMar SOAP watermarkOverlapMs must be a nonnegative integer');
  }

  const postSoap = createSoapTransport({ fetchFn, sleep, signal, timeoutMs, maxResponseBytes });

  async function fetchModifiedStyleIds() {
    if (!normalizedSince) return [];
    const xml = await postSoap({
      url: PRODUCT_DATA_URL,
      action: 'getProductDateModified',
      label: 'date-modified discovery',
      body: createDateModifiedRequest({ username, password, since: normalizedSince }),
    });
    return parseSanMarDateModifiedResponse(xml, { maxResponseBytes });
  }

  async function fetchStyle(requestedStyleId) {
    const normalizedStyleId = requiredText(requestedStyleId, 'styleId', 'style request', 0);
    let xml;
    try {
      xml = await postSoap({
        url: PRODUCT_INFO_URL,
        action: '""',
        label: normalizedStyleId,
        body: createStyleRequest({
          styleId: normalizedStyleId,
          customerNumber,
          username,
          password,
        }),
      });
      return parseSanMarProductInfoResponse(xml, {
        styleId: normalizedStyleId,
        maxResponseBytes,
      });
    } catch (error) {
      if (error?.sanmarErrorKind !== 'product_info_error' || error?.category === ErrorCategory.AUTH) {
        throw error;
      }
      const lookupXml = await postSoap({
        url: PRODUCT_DATA_URL,
        action: 'getProduct',
        label: normalizedStyleId,
        body: createProductLookupRequest({
          styleId: normalizedStyleId,
          username,
          password,
        }),
      });
      const lookup = parseSanMarProductLookupResponse(lookupXml, {
        styleId: normalizedStyleId,
        maxResponseBytes,
      });
      if (lookup.found) throw error;
      return {
        styles: [],
        variants: [],
        message: 'confirmed unavailable',
        responseBytes: 0,
        confirmedUnavailable: true,
      };
    }
  }

  async function ingest({ onStyle, onVariant, shouldContinue }) {
    const snapshotTimestamp = createWatermark(now, watermarkOverlapMs);
    const modifiedStyleIds = await fetchModifiedStyleIds();
    const allStyleIds = Array.from(new Set([...styleIds.map(text), ...modifiedStyleIds])).sort();
    if (allStyleIds.length === 0) {
      throw sourceError(
        ErrorCategory.VALIDATION,
        'SanMar SOAP ingestion has no bootstrap or modified style IDs'
      );
    }

    const hash = createHash('sha256');
    const stylesById = new Map();
    const variantsById = new Map();
    const excludedStyleIds = [];
    let requestCount = 0;

    for (const requestedStyleId of allStyleIds) {
      if (shouldContinue && !(await shouldContinue())) {
        throw sourceError(ErrorCategory.CANCELED, 'SanMar SOAP ingestion canceled');
      }
      const result = await fetchStyle(requestedStyleId);
      requestCount++;
      if (result.variants.length === 0) {
        if (result.confirmedUnavailable !== true) {
          throw sourceError(
            ErrorCategory.VALIDATION,
            `SanMar full SOAP style ${requestedStyleId} returned a successful but empty Product Info response; ` +
              'refusing omission without exact Product Data code-130 confirmation',
            { retryable: false }
          );
        }
        excludedStyleIds.push(requestedStyleId);
      } else {
        for (const style of result.styles) {
          const isNew = addConsistent(stylesById, style.sourceStyleId, style, styleIdentity, 'style');
          if (isNew) {
            hash.update(JSON.stringify(style) + '\n');
            await onStyle(style);
          }
        }
        for (const variant of result.variants) {
          const isNew = addConsistent(
            variantsById,
            variant.sourceVariantId,
            variant,
            variantIdentity,
            'variant'
          );
          if (isNew) {
            hash.update(JSON.stringify(variant) + '\n');
            await onVariant(variant);
          }
        }
      }
      if (requestDelayMs > 0 && requestedStyleId !== allStyleIds.at(-1)) {
        await sleepWithAbort(requestDelayMs, { sleep, signal });
      }
    }

    if (stylesById.size === 0 || variantsById.size === 0) {
      throw sourceError(
        ErrorCategory.VALIDATION,
        'SanMar SOAP all requested styles returned zero products; refusing incomplete catalog'
      );
    }

    return {
      vendor: 'sanmar',
      styleCount: stylesById.size,
      variantCount: variantsById.size,
      skippedCount: 0,
      sourceErrors: 0,
      complete: true,
      contentHash: hash.digest('hex'),
      source: 'sanmar-soap-style-delta',
      snapshotTimestamp,
      bootstrapStyleCount: new Set(styleIds.map(text)).size,
      modifiedStyleCount: modifiedStyleIds.length,
      requestedStyleCount: allStyleIds.length,
      requestCount,
      excludedStyleCount: excludedStyleIds.length,
      excludedStyleSamples: excludedStyleIds.slice(0, 25),
      reasons: [],
    };
  }

  return { fetchModifiedStyleIds, fetchStyle, ingest };
}

function createSoapTransport({ fetchFn, sleep, signal, timeoutMs, maxResponseBytes }) {
  return async function postSoap({ url, action, label, body }) {
    if (!url.startsWith(`${SANMAR_ORIGIN}/`)) {
      throw sourceError(ErrorCategory.VALIDATION, 'SanMar SOAP URL is outside the fixed origin');
    }
    return withRetry(async () => {
      if (signal?.aborted) throw sourceError(ErrorCategory.CANCELED, 'SanMar SOAP request canceled');
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': action,
            'Accept': 'text/xml, application/soap+xml',
          },
          body,
          redirect: 'error',
          signal: requestSignal,
        });
        if (response.status === 401 || response.status === 403) {
          throw sourceError(ErrorCategory.AUTH, 'SanMar SOAP authentication failed', {
            statusCode: response.status,
            url,
          });
        }
        if (response.status === 429) {
          const error = sourceError(ErrorCategory.RATE_LIMIT, 'SanMar SOAP rate limited', {
            statusCode: 429,
            url,
            retryable: true,
          });
          error.retryAfter = response.headers?.get?.('retry-after') ?? undefined;
          throw error;
        }
        if (response.status >= 500) {
          throw sourceError(ErrorCategory.SERVER, `SanMar SOAP server error (${response.status})`, {
            statusCode: response.status,
            url,
            retryable: true,
          });
        }
        if (!response.ok) {
          throw sourceError(ErrorCategory.SERVER, `SanMar SOAP HTTP ${response.status}`, {
            statusCode: response.status,
            url,
          });
        }
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          throw sourceError(
            ErrorCategory.VALIDATION,
            `SanMar SOAP response for ${safeLabel(label)} exceeds ${maxResponseBytes} bytes`
          );
        }
        const xml = await readResponseText(response, { label, maxResponseBytes });
        return xml;
      } catch (error) {
        if (error?.category) throw error;
        if (error?.name === 'AbortError') {
          if (signal?.aborted) throw sourceError(ErrorCategory.CANCELED, 'SanMar SOAP request canceled');
          throw sourceError(ErrorCategory.TIMEOUT, `SanMar SOAP request timed out for ${safeLabel(label)}`, {
            url,
            retryable: true,
          });
        }
        throw sourceError(ErrorCategory.NETWORK, 'SanMar SOAP network request failed', {
          url,
          retryable: true,
        });
      } finally {
        clearTimeout(timeout);
      }
    }, { maxRetries: 3, sleep, signal });
  };
}

async function readResponseText(response, { label, maxResponseBytes }) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw sourceError(
      ErrorCategory.VALIDATION,
      `SanMar SOAP response for ${safeLabel(label)} has no readable body stream`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let xml = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        throw sourceError(
          ErrorCategory.VALIDATION,
          `SanMar SOAP response for ${safeLabel(label)} returned an invalid body chunk`
        );
      }
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw sourceError(
          ErrorCategory.VALIDATION,
          `SanMar SOAP response for ${safeLabel(label)} exceeds ${maxResponseBytes} bytes`
        );
      }
      xml += decoder.decode(value, { stream: true });
    }
    return xml + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeProductRow(row, { label, index }) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar ${label} row ${index} is not an object`);
  }
  const basic = requireObject(row.productBasicInfo, `productBasicInfo for ${label} row ${index}`);
  const image = optionalObject(row.productImageInfo);
  const price = requireObject(row.productPriceInfo, `productPriceInfo for ${label} row ${index}`);
  const sourceVariantId = requiredText(basic.uniqueKey, 'uniqueKey', label, index);
  const styleCode = requiredText(basic.style, 'style', label, index);
  const color = requiredText(basic.color ?? basic.catalogColor, 'color', label, index);
  const size = requiredText(basic.size, 'size', label, index);
  const piecePrice = requiredPositiveNumber(price.piecePrice, 'piecePrice', label, index);
  const dozenPrice = optionalNonnegativeNumber(price.dozenPrice, 'dozenPrice', label, index);
  const casePrice = requiredPositiveNumber(price.casePrice, 'casePrice', label, index);
  const sizeOrder = optionalInteger(basic.sizeIndex, 'sizeIndex', label, index);
  const status = normalizeProductStatus(basic.productStatus, label, index);

  return {
    style: {
      sourceStyleId: styleCode,
      styleCode,
      brand: text(basic.brandName) || undefined,
      name: text(basic.productTitle) || undefined,
      category: text(basic.category) || undefined,
      description: text(basic.productDescription) || undefined,
      imageUrl: firstText(image.productImage, image.frontModel, image.colorProductImage) || undefined,
    },
    variant: {
      sourceVariantId,
      sourceStyleId: styleCode,
      styleCode,
      color,
      size,
      sizeOrder,
      inventoryQty: undefined,
      imageUrl: firstText(image.colorProductImage, image.productImage, image.frontModel) || undefined,
      discontinued: /discontinued|closeout/i.test(status),
      piecePrice,
      dozenPrice,
      casePrice,
      salePrice: undefined,
      customerPrice: undefined,
      resolvedCost: casePrice,
      costBasis: 'casePrice',
    },
  };
}

function createStyleRequest({ styleId, customerNumber, username, password }) {
  return envelope(
    `<impl:getProductInfoByStyleColorSize>` +
    `<arg0><style>${escapeXml(styleId)}</style></arg0>` +
    `<arg1>${webUserXml({ customerNumber, username, password })}</arg1>` +
    `</impl:getProductInfoByStyleColorSize>`
  );
}

function createProductLookupRequest({ styleId, username, password }) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:ns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/" ` +
    `xmlns:shar="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/">` +
    `<soapenv:Header/><soapenv:Body><ns:GetProductRequest>` +
    `<shar:wsVersion>2.0.0</shar:wsVersion><shar:id>${escapeXml(username)}</shar:id>` +
    `<shar:password>${escapeXml(password)}</shar:password>` +
    `<shar:localizationCountry>us</shar:localizationCountry>` +
    `<shar:localizationLanguage>en</shar:localizationLanguage>` +
    `<shar:productId>${escapeXml(styleId)}</shar:productId>` +
    `</ns:GetProductRequest></soapenv:Body></soapenv:Envelope>`;
}

function createDateModifiedRequest({ username, password, since }) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:ns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/" ` +
    `xmlns:shar="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/">` +
    `<soapenv:Header/><soapenv:Body><ns:GetProductDateModifiedRequest>` +
    `<shar:wsVersion>2.0.0</shar:wsVersion><shar:id>${escapeXml(username)}</shar:id>` +
    `<shar:password>${escapeXml(password)}</shar:password>` +
    `<shar:changeTimeStamp>${escapeXml(since)}</shar:changeTimeStamp>` +
    `</ns:GetProductDateModifiedRequest></soapenv:Body></soapenv:Envelope>`;
}

function envelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:impl="http://impl.webservice.integration.sanmar.com/">` +
    `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function webUserXml({ customerNumber, username, password }) {
  return `<sanMarCustomerNumber>${escapeXml(customerNumber)}</sanMarCustomerNumber>` +
    `<sanMarUserName>${escapeXml(username)}</sanMarUserName>` +
    `<sanMarUserPassword>${escapeXml(password)}</sanMarUserPassword>` +
    `<senderId></senderId><senderPassword></senderPassword>`;
}

function parseSoapXml(xml, { label, maxResponseBytes, expectedOperation, expectedNamespace }) {
  assertPositiveSafeInteger(maxResponseBytes, 'maxResponseBytes', MAX_RESPONSE_BYTES, true);
  if (typeof xml !== 'string') throw sourceError(ErrorCategory.PARSE, `SanMar SOAP response for ${label} is not text`);
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes === 0) throw sourceError(ErrorCategory.PARSE, `SanMar SOAP response for ${label} is empty`);
  if (bytes > maxResponseBytes) {
    throw sourceError(ErrorCategory.VALIDATION, `SanMar SOAP response for ${label} exceeds ${maxResponseBytes} bytes`);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw sourceError(
      ErrorCategory.PARSE,
      `SanMar SOAP response for ${label} contains a forbidden DOCTYPE or ENTITY declaration`
    );
  }
  try {
    const namespacedDocument = namespaceParser.parse(xml);
    validateSoapNamespaces(namespacedDocument, { label, expectedOperation, expectedNamespace });
    return parser.parse(xml);
  } catch (error) {
    if (error?.category) throw error;
    throw sourceError(ErrorCategory.PARSE, `SanMar SOAP response for ${label} is malformed XML`);
  }
}

function validateSoapNamespaces(document, { label, expectedOperation, expectedNamespace }) {
  const rootElements = elementKeys(document);
  if (rootElements.length !== 1 || localName(rootElements[0]) !== 'Envelope') {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Envelope`);
  }

  const envelopeName = rootElements[0];
  const envelope = document[envelopeName];
  if (!isObject(envelope)) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Envelope`);
  }
  const envelopeNamespaces = namespaceContext(envelope);
  if (resolveNamespace(envelopeName, envelopeNamespaces) !== SOAP_ENVELOPE_NAMESPACE) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} has an invalid SOAP Envelope namespace`);
  }

  const envelopeElements = elementKeys(envelope);
  const bodyNames = envelopeElements.filter((name) => localName(name) === 'Body');
  if (bodyNames.length !== 1) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Body`);
  }
  for (const name of envelopeElements) {
    const local = localName(name);
    if (!['Header', 'Body'].includes(local) || resolveNamespace(name, namespaceContext(envelope[name], envelopeNamespaces)) !== SOAP_ENVELOPE_NAMESPACE) {
      throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} has an off-schema SOAP Envelope`);
    }
  }

  const bodyName = bodyNames[0];
  const body = envelope[bodyName];
  if (!isObject(body)) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Body`);
  }
  const bodyNamespaces = namespaceContext(body, envelopeNamespaces);
  const bodyElements = elementKeys(body);
  if (bodyElements.length !== 1) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP operation`);
  }

  const operationName = bodyElements[0];
  const operationLocalName = localName(operationName);
  const operation = body[operationName];
  const operationNamespaces = namespaceContext(operation, bodyNamespaces);
  if (operationLocalName === 'Fault') {
    if (resolveNamespace(operationName, operationNamespaces) !== SOAP_ENVELOPE_NAMESPACE) {
      throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} has an invalid SOAP Fault namespace`);
    }
    return;
  }
  if (
    operationLocalName !== expectedOperation ||
    !isObject(operation) ||
    resolveNamespace(operationName, operationNamespaces) !== expectedNamespace
  ) {
    throw sourceError(
      ErrorCategory.SCHEMA,
      `SanMar SOAP response for ${label} must contain ${expectedOperation} in the expected namespace`
    );
  }
  rejectNestedSoapOperations(operation, label);
}

function rejectNestedSoapOperations(operation, label) {
  const forbidden = new Set([
    'Fault',
    'getProductInfoByStyleColorSizeResponse',
    'GetProductDateModifiedResponse',
    'GetProductResponse',
  ]);
  const visit = (value) => {
    if (!isObject(value)) return;
    for (const [name, child] of Object.entries(value)) {
      if (name.startsWith('@_') || name.startsWith('?') || name === '#text') continue;
      if (forbidden.has(localName(name))) {
        throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} contains a nested SOAP operation`);
      }
      for (const item of toArray(child)) visit(item);
    }
  };
  visit(operation);
}

function namespaceContext(value, inherited = new Map()) {
  const context = new Map(inherited);
  if (!isObject(value)) return context;
  for (const [name, uri] of Object.entries(value)) {
    if (name === '@_xmlns') context.set('', text(uri));
    else if (name.startsWith('@_xmlns:')) context.set(name.slice('@_xmlns:'.length), text(uri));
  }
  return context;
}

function resolveNamespace(name, context) {
  const separator = name.indexOf(':');
  return separator === -1 ? context.get('') ?? '' : context.get(name.slice(0, separator)) ?? '';
}

function localName(name) {
  const separator = name.indexOf(':');
  return separator === -1 ? name : name.slice(separator + 1);
}

function requireSoapOperation(document, label, expectedOperation) {
  const documentElements = elementKeys(document);
  if (
    documentElements.length !== 1 ||
    documentElements[0] !== 'Envelope' ||
    !isObject(document.Envelope)
  ) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Envelope`);
  }

  const envelope = document.Envelope;
  const envelopeElements = elementKeys(envelope);
  if (
    envelopeElements.filter((key) => key === 'Body').length !== 1 ||
    !isObject(envelope.Body)
  ) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} must contain exactly one SOAP Body`);
  }
  if (envelopeElements.some((key) => key !== 'Header' && key !== 'Body')) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} has an off-schema SOAP Envelope`);
  }
  if (envelope.Header != null && !isObject(envelope.Header) && envelope.Header !== '') {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar SOAP response for ${label} has a malformed SOAP Header`);
  }

  const body = envelope.Body;
  if (Object.prototype.hasOwnProperty.call(body, 'Fault')) {
    throw sourceError(ErrorCategory.SERVER, `SanMar SOAP fault for ${label}`);
  }
  const bodyElements = elementKeys(body);
  if (
    bodyElements.length !== 1 ||
    bodyElements[0] !== expectedOperation ||
    !isObject(body[expectedOperation])
  ) {
    throw sourceError(
      ErrorCategory.SCHEMA,
      `SanMar SOAP response for ${label} must contain exactly one ${expectedOperation} element in the SOAP Body`
    );
  }
  return body[expectedOperation];
}

function elementKeys(value) {
  if (!isObject(value)) return [];
  return Object.keys(value).filter(
    (key) => !key.startsWith('@_') && !key.startsWith('?') && key !== '#text'
  );
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function addConsistent(map, key, value, identity, type) {
  const previous = map.get(key);
  if (!previous) {
    map.set(key, value);
    return true;
  }
  if (identity(previous) !== identity(value)) {
    throw sourceError(ErrorCategory.VALIDATION, `SanMar duplicate ${type} with conflicting identity for ${safeLabel(key)}`);
  }
  return false;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function findAllByKey(value, wantedKey, results = []) {
  if (value == null || typeof value !== 'object') return results;
  if (Object.prototype.hasOwnProperty.call(value, wantedKey)) {
    results.push(...toArray(value[wantedKey]));
  }
  for (const child of Object.values(value)) findAllByKey(child, wantedKey, results);
  return results;
}

function sourceError(category, message, options = {}) {
  return createSourceError(category, message, { retryable: false, ...options });
}

function requireObject(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar row missing ${label}`);
  }
  return value;
}

function optionalObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredText(value, field, label, index) {
  const normalized = text(value);
  if (!normalized) throw sourceError(ErrorCategory.SCHEMA, `SanMar ${label} row ${index} missing required ${field}`);
  return normalized;
}

function requiredPositiveNumber(value, field, label, index) {
  const number = Number(text(value));
  if (!Number.isFinite(number) || number <= 0) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar ${label} row ${index} has invalid ${field}`);
  }
  return number;
}

function optionalNonnegativeNumber(value, field, label, index) {
  if (value == null || text(value) === '') return undefined;
  const number = Number(text(value));
  if (!Number.isFinite(number) || number < 0) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar ${label} row ${index} has invalid ${field}`);
  }
  return number;
}

function optionalInteger(value, field, label, index) {
  if (value == null || text(value) === '') return undefined;
  const number = Number(text(value));
  if (!Number.isSafeInteger(number) || number < 0) {
    throw sourceError(ErrorCategory.SCHEMA, `SanMar ${label} row ${index} has invalid ${field}`);
  }
  return number;
}

function normalizeProductStatus(value, label, index) {
  const normalized = text(value).toLowerCase().replace(/\s+/g, ' ');
  const active = new Set(['active', 'regular', 'new', 'coming soon']);
  const inactive = new Set(['discontinued']);
  if (!active.has(normalized) && !inactive.has(normalized)) {
    throw sourceError(
      ErrorCategory.SCHEMA,
      `SanMar ${label} row ${index} has unknown productStatus`
    );
  }
  return normalized;
}

function assertPositiveSafeInteger(value, name, maximum, asSourceError = false) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    const message = `SanMar SOAP ${name} must be a positive safe integer no greater than ${maximum}`;
    if (asSourceError) throw sourceError(ErrorCategory.VALIDATION, message);
    throw new Error(message);
  }
}

function createWatermark(now, overlapMs) {
  const captured = now();
  const date = captured instanceof Date ? captured : new Date(captured);
  if (Number.isNaN(date.getTime())) throw new Error('SanMar SOAP now must return a valid date');
  return new Date(date.getTime() - overlapMs).toISOString();
}

function normalizeSince(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('SanMar SOAP since must be a valid date');
  if (date.getTime() > Date.now() + 60_000) throw new Error('SanMar SOAP since must not be in the future');
  return date.toISOString();
}

function text(value) {
  if (value == null) return '';
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value).trim();
  return '';
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return '';
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeLabel(value) {
  const normalized = text(value).replace(/[^A-Za-z0-9 +&./_-]/g, '').slice(0, 100);
  return normalized || '[unknown]';
}

function styleIdentity(style) {
  return JSON.stringify({
    sourceStyleId: style.sourceStyleId,
    styleCode: style.styleCode,
    brand: style.brand ?? null,
    name: style.name ?? null,
    category: style.category ?? null,
    description: style.description ?? null,
  });
}

function variantIdentity(variant) {
  return JSON.stringify({
    sourceStyleId: variant.sourceStyleId,
    styleCode: variant.styleCode,
    color: variant.color ?? null,
    size: variant.size ?? null,
    sizeOrder: variant.sizeOrder ?? null,
    discontinued: variant.discontinued,
    piecePrice: variant.piecePrice ?? null,
    dozenPrice: variant.dozenPrice ?? null,
    casePrice: variant.casePrice ?? null,
    resolvedCost: variant.resolvedCost,
    costBasis: variant.costBasis,
  });
}

/**
 * Create a SanMar delta source that discovers modified/new style IDs
 * and fetches only those styles. Returns per-style results for the
 * orchestrator to patch into a cloned import.
 *
 * Unlike createSanMarSoapSource, this does NOT fetch all bootstrap styles.
 * It only fetches styles discovered by getProductDateModified.
 */
export function createSanMarDeltaSource({
  customerNumber,
  username,
  password,
  since,
  fetch: fetchFn = globalThis.fetch,
  sleep,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  now = () => new Date(),
  watermarkOverlapMs = DEFAULT_WATERMARK_OVERLAP_MS,
} = {}) {
  if (!customerNumber || !username || !password) {
    throw new Error('SanMar delta credentials (customerNumber, username, password) are required');
  }
  if (typeof fetchFn !== 'function') throw new Error('SanMar delta fetch implementation is required');
  const normalizedSince = normalizeSince(since);
  if (!normalizedSince) {
    throw new Error('SanMar delta mode requires a valid since watermark');
  }
  assertPositiveSafeInteger(timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  assertPositiveSafeInteger(maxResponseBytes, 'maxResponseBytes', MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(requestDelayMs) || requestDelayMs < 0 || requestDelayMs > 60_000) {
    throw new Error('SanMar delta requestDelayMs must be an integer from 0 through 60000');
  }
  if (typeof now !== 'function') throw new Error('SanMar delta now must be a function');
  if (!Number.isSafeInteger(watermarkOverlapMs) || watermarkOverlapMs < 0) {
    throw new Error('SanMar delta watermarkOverlapMs must be a nonnegative integer');
  }

  const postSoap = createSoapTransport({ fetchFn, sleep, signal, timeoutMs, maxResponseBytes });

  async function fetchModifiedStyleIds() {
    const xml = await postSoap({
      url: PRODUCT_DATA_URL,
      action: 'getProductDateModified',
      label: 'delta date-modified discovery',
      body: createDateModifiedRequest({ username, password, since: normalizedSince }),
    });
    return parseSanMarDateModifiedResponse(xml, { maxResponseBytes });
  }

  async function fetchStyle(requestedStyleId) {
    const normalizedStyleId = requiredText(requestedStyleId, 'styleId', 'delta style request', 0);
    let xml;
    try {
      xml = await postSoap({
        url: PRODUCT_INFO_URL,
        action: '""',
        label: normalizedStyleId,
        body: createStyleRequest({
          styleId: normalizedStyleId,
          customerNumber,
          username,
          password,
        }),
      });
      return parseSanMarProductInfoResponse(xml, {
        styleId: normalizedStyleId,
        maxResponseBytes,
      });
    } catch (error) {
      if (error?.sanmarErrorKind !== 'product_info_error' || error?.category === ErrorCategory.AUTH) {
        throw error;
      }
      const lookupXml = await postSoap({
        url: PRODUCT_DATA_URL,
        action: 'getProduct',
        label: normalizedStyleId,
        body: createProductLookupRequest({
          styleId: normalizedStyleId,
          username,
          password,
        }),
      });
      const lookup = parseSanMarProductLookupResponse(lookupXml, {
        styleId: normalizedStyleId,
        maxResponseBytes,
      });
      if (lookup.found) throw error;
      return {
        styles: [],
        variants: [],
        message: 'confirmed unavailable',
        responseBytes: 0,
        confirmedUnavailable: true,
      };
    }
  }

  /**
   * Discover and fetch changed/new styles. Returns structured results
   * that the delta orchestrator uses to patch the cloned import.
   *
   * @param {Object} options
   * @param {Function} [options.shouldContinue] - Cancellation check
   * @returns {Promise<Object>} Delta discovery result
   */
  async function discover({ shouldContinue } = {}) {
    const snapshotTimestamp = createWatermark(now, watermarkOverlapMs);
    const modifiedStyleIds = await fetchModifiedStyleIds();

    const results = [];
    const excludedStyleIds = [];
    let requestCount = 0;

    for (const styleId of modifiedStyleIds) {
      if (shouldContinue && !(await shouldContinue())) {
        throw sourceError(ErrorCategory.CANCELED, 'SanMar delta discovery canceled');
      }

      const result = await fetchStyle(styleId);
      requestCount++;

      if (result.variants.length === 0) {
        if (result.confirmedUnavailable !== true) {
          throw sourceError(
            ErrorCategory.VALIDATION,
            `SanMar delta style ${styleId} returned a successful but empty Product Info response; ` +
              'refusing removal without exact Product Data code-130 confirmation',
            { retryable: false }
          );
        }
        // Confirmed unavailable via exact Product Data code-130 reconciliation.
        results.push({ styleId, action: 'remove', styles: [], variants: [] });
        excludedStyleIds.push(styleId);
      } else {
        // Validate no conflicting duplicates within this style's response
        const stylesById = new Map();
        const variantsById = new Map();
        for (const style of result.styles) {
          addConsistent(stylesById, style.sourceStyleId, style, styleIdentity, 'style');
        }
        for (const variant of result.variants) {
          addConsistent(variantsById, variant.sourceVariantId, variant, variantIdentity, 'variant');
        }
        results.push({
          styleId,
          action: 'replace',
          styles: result.styles,
          variants: result.variants,
        });
      }

      if (requestDelayMs > 0 && styleId !== modifiedStyleIds.at(-1)) {
        await sleepWithAbort(requestDelayMs, { sleep, signal });
      }
    }

    return {
      snapshotTimestamp,
      modifiedStyleIds,
      results,
      requestCount,
      excludedStyleIds,
      excludedStyleCount: excludedStyleIds.length,
    };
  }

  return { fetchModifiedStyleIds, fetchStyle, discover };
}

async function sleepWithAbort(ms, { sleep, signal }) {
  if (!sleep) return abortableSleep(ms, { signal });
  if (!signal) return sleep(ms);
  if (signal.aborted) throw sourceError(ErrorCategory.CANCELED, 'SanMar SOAP sleep canceled');
  let remove;
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(sourceError(ErrorCategory.CANCELED, 'SanMar SOAP sleep canceled'));
    remove = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    remove?.();
  }
}
