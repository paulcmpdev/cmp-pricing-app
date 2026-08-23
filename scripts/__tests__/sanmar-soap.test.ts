import { describe, expect, it, vi } from 'vitest';
import {
  createSanMarSoapSource,
  parseSanMarDateModifiedResponse,
  parseSanMarProductInfoResponse,
  parseSanMarProductLookupResponse,
} from '../lib/vendor-sources/sanmar-soap.mjs';

const PRODUCT_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns2:getProductInfoByStyleColorSizeResponse xmlns:ns2="http://impl.webservice.integration.sanmar.com/">
      <return>
        <errorOccured>false</errorOccured>
        <listResponse>
          <productBasicInfo>
            <brandName>Port Authority</brandName>
            <catalogColor>Black</catalogColor>
            <color>Deep Black</color>
            <inventoryKey>20828</inventoryKey>
            <productDescription>Classic &amp; durable polo</productDescription>
            <productStatus>Regular</productStatus>
            <productTitle>Port Authority Silk Touch Polo K500</productTitle>
            <size>M</size>
            <sizeIndex>3</sizeIndex>
            <style>K500</style>
            <uniqueKey>208283</uniqueKey>
            <category>Polos/Knits</category>
          </productBasicInfo>
          <productImageInfo>
            <productImage>https://cdn.example.com/K500.jpg</productImage>
            <colorProductImage>https://cdn.example.com/K500-black.jpg</colorProductImage>
          </productImageInfo>
          <productPriceInfo>
            <casePrice>9.30</casePrice>
            <dozenPrice>10.30</dozenPrice>
            <piecePrice>11.30</piecePrice>
          </productPriceInfo>
        </listResponse>
        <listResponse>
          <productBasicInfo>
            <brandName>Port Authority</brandName>
            <catalogColor>Black</catalogColor>
            <color>Deep Black</color>
            <inventoryKey>20828</inventoryKey>
            <productDescription>Classic &amp; durable polo</productDescription>
            <productStatus>Discontinued</productStatus>
            <productTitle>Port Authority Silk Touch Polo K500</productTitle>
            <size>L</size>
            <sizeIndex>4</sizeIndex>
            <style>K500</style>
            <uniqueKey>208284</uniqueKey>
            <category>Polos/Knits</category>
          </productBasicInfo>
          <productImageInfo>
            <productImage>https://cdn.example.com/K500.jpg</productImage>
          </productImageInfo>
          <productPriceInfo>
            <casePrice>9.30</casePrice>
            <dozenPrice>10.30</dozenPrice>
            <piecePrice>11.30</piecePrice>
          </productPriceInfo>
        </listResponse>
        <message>Product Info sent successfully.</message>
      </return>
    </ns2:getProductInfoByStyleColorSizeResponse>
  </S:Body>
</S:Envelope>`;

function response(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/xml' },
  });
}

describe('SanMar SOAP product adapter', () => {
  it('parses a namespace-qualified product response strictly', () => {
    const result = parseSanMarProductInfoResponse(PRODUCT_RESPONSE, { brand: 'Port Authority' });

    expect(result.message).toMatch(/successfully/i);
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]).toMatchObject({
      sourceVariantId: '208283',
      sourceStyleId: 'K500',
      styleCode: 'K500',
      color: 'Deep Black',
      size: 'M',
      sizeOrder: 3,
      inventoryQty: undefined,
      piecePrice: 11.3,
      dozenPrice: 10.3,
      casePrice: 9.3,
      resolvedCost: 11.3,
      costBasis: 'piecePrice',
      discontinued: false,
    });
    expect(result.variants[1].discontinued).toBe(true);
    expect(result.styles).toEqual([
      expect.objectContaining({
        sourceStyleId: 'K500',
        brand: 'Port Authority',
        description: 'Classic & durable polo',
      }),
    ]);
  });

  it('rejects wrong-operation and nested-operation response structures', () => {
    const wrongProductInfo = PRODUCT_RESPONSE
      .replaceAll('getProductInfoByStyleColorSizeResponse', 'getProductInfoByBrandResponse');
    expect(() => parseSanMarProductInfoResponse(wrongProductInfo, { styleId: 'K500' }))
      .toThrow(/getProductInfoByStyleColorSizeResponse/i);

    const nestedDateModified = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray/></ns2:GetProductDateModifiedResponse></ns2:GetProductResponse></S:Body></S:Envelope>`;
    expect(() => parseSanMarDateModifiedResponse(nestedDateModified))
      .toThrow(/GetProductDateModifiedResponse/i);

    const nestedProduct = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><Product><productId>K500</productId></Product></ns2:GetProductResponse></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;
    expect(() => parseSanMarProductLookupResponse(nestedProduct, { styleId: 'K500' }))
      .toThrow(/GetProductResponse/i);
  });

  it('rejects arbitrary SOAP and operation namespaces plus nested operations', () => {
    const fakeSoap = `<x:Envelope xmlns:x="urn:not-soap"><x:Body><x:GetProductResponse><Product><productId>K500</productId></Product></x:GetProductResponse></x:Body></x:Envelope>`;
    expect(() => parseSanMarProductLookupResponse(fakeSoap, { styleId: 'K500' }))
      .toThrow(/namespace/i);

    const nestedWrongOperation = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ns2:GetProductResponse><Product><productId>K500</productId></Product></ns2:GetProductResponse><ProductDateModifiedArray/></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;
    expect(() => parseSanMarDateModifiedResponse(nestedWrongOperation))
      .toThrow(/nested SOAP operation/i);
  });

  it('requires exactly one SOAP Envelope and Body', () => {
    const duplicateBody = PRODUCT_RESPONSE.replace(
      '</S:Body>\n</S:Envelope>',
      '</S:Body><S:Body></S:Body>\n</S:Envelope>'
    );
    expect(() => parseSanMarProductInfoResponse(duplicateBody, { styleId: 'K500' }))
      .toThrow(/exactly one SOAP Body/i);

    const extraEnvelope = `${PRODUCT_RESPONSE}${PRODUCT_RESPONSE}`;
    expect(() => parseSanMarProductInfoResponse(extraEnvelope, { styleId: 'K500' }))
      .toThrow(/exactly one SOAP Envelope/i);
  });

  it('rejects SOAP faults without including response bodies', () => {
    const fault = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Internal service failure</faultstring></S:Fault></S:Body></S:Envelope>`;
    expect(() => parseSanMarProductInfoResponse(fault, { brand: 'Port Authority' }))
      .toThrow(/SOAP fault.*Port Authority/i);
  });

  it('rejects vendor error flags', () => {
    const failure = PRODUCT_RESPONSE
      .replace('<errorOccured>false</errorOccured>', '<errorOccured>true</errorOccured>')
      .replace('Product Info sent successfully.', 'ERROR: User authenticating failed');
    expect(() => parseSanMarProductInfoResponse(failure, { brand: 'Port Authority' }))
      .toThrow(/reported an error.*Port Authority/i);
  });

  it('rejects DOCTYPE and entity declarations', () => {
    const malicious = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${PRODUCT_RESPONSE}`;
    expect(() => parseSanMarProductInfoResponse(malicious, { brand: 'Port Authority' }))
      .toThrow(/DOCTYPE|ENTITY/i);
  });

  it('rejects missing required variant identity', () => {
    const malformed = PRODUCT_RESPONSE.replace('<uniqueKey>208283</uniqueKey>', '<uniqueKey></uniqueKey>');
    expect(() => parseSanMarProductInfoResponse(malformed, { brand: 'Port Authority' }))
      .toThrow(/uniqueKey/i);
  });

  it('rejects invalid or zero piece prices', () => {
    const malformed = PRODUCT_RESPONSE.replace('<piecePrice>11.30</piecePrice>', '<piecePrice>0</piecePrice>');
    expect(() => parseSanMarProductInfoResponse(malformed, { brand: 'Port Authority' }))
      .toThrow(/piecePrice/i);
  });

  it('rejects unknown product statuses', () => {
    const malformed = PRODUCT_RESPONSE.replace('<productStatus>Regular</productStatus>', '<productStatus>Mystery</productStatus>');
    expect(() => parseSanMarProductInfoResponse(malformed, { styleId: 'K500' }))
      .toThrow(/unknown productStatus/i);
  });

  it('fetches every bootstrap style and emits a complete manifest', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(PRODUCT_RESPONSE));
    const source = createSanMarSoapSource({
      customerNumber: 'customer',
      username: 'user',
      password: 'password',
      styleIds: ['K500'],
      fetch: fetchMock,
      sleep: vi.fn(),
      requestDelayMs: 0,
    });
    const styles: any[] = [];
    const variants: any[] = [];

    const manifest = await source.ingest({
      onStyle: (style: any) => { styles.push(style); },
      onVariant: (variant: any) => { variants.push(variant); },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort');
    expect(options.method).toBe('POST');
    expect(options.body).toContain('<style>K500</style>');
    expect(options.body).not.toContain('<sanMarUserName>user</sanMarUserName><sanMarUserPassword>user</sanMarUserPassword>');
    expect(styles).toHaveLength(1);
    expect(variants).toHaveLength(2);
    expect(manifest).toMatchObject({
      vendor: 'sanmar',
      styleCount: 1,
      variantCount: 2,
      skippedCount: 0,
      sourceErrors: 0,
      complete: true,
      source: 'sanmar-soap-style-delta',
      bootstrapStyleCount: 1,
      modifiedStyleCount: 0,
      requestedStyleCount: 1,
    });
  });

  it('cancels a chunked response as soon as decompressed bytes exceed the cap', async () => {
    const cancel = vi.fn();
    const chunks = [
      new TextEncoder().encode('<S:Envelope>'),
      new TextEncoder().encode('response body beyond cap'),
      new TextEncoder().encode('must not be decoded'),
      new TextEncoder().encode('or buffered to completion'),
    ];
    let pullIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullIndex < chunks.length) controller.enqueue(chunks[pullIndex++]);
        else controller.close();
      },
      cancel,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    }));
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['K500'], fetch: fetchMock, sleep: vi.fn(), requestDelayMs: 0,
      maxResponseBytes: 20,
    });

    await expect(source.fetchStyle('K500')).rejects.toThrow(/exceeds 20 bytes/i);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pullIndex).toBeLessThan(chunks.length);
  });

  it('fails closed when a successful response has no readable body stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/xml' }),
      body: null,
      text: () => Promise.resolve(PRODUCT_RESPONSE),
    } as unknown as Response);
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['K500'], fetch: fetchMock, sleep: vi.fn(), requestDelayMs: 0,
    });

    await expect(source.fetchStyle('K500')).rejects.toThrow(/no readable body stream/i);
  });

  it.each([NaN, Infinity, 0, -1, 256 * 1024 * 1024 + 1])(
    'rejects invalid parser maxResponseBytes %s',
    (maxResponseBytes) => {
      expect(() => parseSanMarProductInfoResponse(PRODUCT_RESPONSE, { styleId: 'K500', maxResponseBytes }))
        .toThrow(/maxResponseBytes/i);
    }
  );

  it.each([
    { field: 'timeoutMs', value: NaN },
    { field: 'timeoutMs', value: Infinity },
    { field: 'timeoutMs', value: 0 },
    { field: 'timeoutMs', value: -1 },
    { field: 'timeoutMs', value: 10 * 60 * 1000 + 1 },
    { field: 'maxResponseBytes', value: NaN },
    { field: 'maxResponseBytes', value: Infinity },
    { field: 'maxResponseBytes', value: 0 },
    { field: 'maxResponseBytes', value: -1 },
    { field: 'maxResponseBytes', value: 256 * 1024 * 1024 + 1 },
  ])('rejects invalid source $field=$value', ({ field, value }) => {
    expect(() => createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password', styleIds: ['K500'],
      [field]: value,
    })).toThrow(new RegExp(field, 'i'));
  });

  it('captures the default-overlap watermark before discovery and persists it exactly', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(new Date('2026-08-22T12:10:00.000Z'))
      .mockReturnValue(new Date('2026-08-22T13:00:00.000Z'));
    const discovery = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray/></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(discovery))
      .mockResolvedValueOnce(response(PRODUCT_RESPONSE));
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['K500'], since: '2026-08-22T11:00:00.000Z', fetch: fetchMock,
      sleep: vi.fn(), requestDelayMs: 0, now,
    });

    const manifest = await source.ingest({ onStyle: () => {}, onVariant: () => {} });

    expect(now).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toContain(
      '<shar:changeTimeStamp>2026-08-22T11:00:00.000Z</shar:changeTimeStamp>'
    );
    expect(manifest.snapshotTimestamp).toBe('2026-08-22T12:05:00.000Z');
  });

  it('uses a configurable overlap for the pre-discovery watermark', async () => {
    const discovery = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray/></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(discovery))
      .mockResolvedValueOnce(response(PRODUCT_RESPONSE));
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['K500'], since: '2026-08-22T11:00:00.000Z', fetch: fetchMock,
      sleep: vi.fn(), requestDelayMs: 0,
      now: () => new Date('2026-08-22T12:10:00.000Z'), watermarkOverlapMs: 60_000,
    });

    const manifest = await source.ingest({ onStyle: () => {}, onVariant: () => {} });

    expect(manifest.snapshotTimestamp).toBe('2026-08-22T12:09:00.000Z');
  });

  it('discovers unique modified/new style IDs', () => {
    const xml = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductDateModifiedResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ProductDateModifiedArray><ProductDateModified><productId>K500</productId><partId>1</partId></ProductDateModified><ProductDateModified><productId>K500</productId><partId>2</partId></ProductDateModified><ProductDateModified><productId>NEW100</productId><partId>3</partId></ProductDateModified></ProductDateModifiedArray></ns2:GetProductDateModifiedResponse></S:Body></S:Envelope>`;
    expect(parseSanMarDateModifiedResponse(xml)).toEqual(['K500', 'NEW100']);
  });

  it('rejects a run where every isolated style is unavailable', async () => {
    const empty = PRODUCT_RESPONSE.replace(/<listResponse>[\s\S]*<\/listResponse>/, '');
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['EMPTY'], fetch: vi.fn().mockResolvedValue(response(empty)), sleep: vi.fn(), requestDelayMs: 0,
    });
    await expect(source.ingest({ onStyle: () => {}, onVariant: () => {} }))
      .rejects.toThrow(/all requested styles returned zero products/i);
  });

  it('rejects duplicate variant IDs with conflicting identities', () => {
    const conflict = PRODUCT_RESPONSE
      .replace('<uniqueKey>208284</uniqueKey>', '<uniqueKey>208283</uniqueKey>')
      .replace('<size>L</size>', '<size>XL</size>');
    expect(() => parseSanMarProductInfoResponse(conflict, { styleId: 'K500' }))
      .toThrow(/duplicate.*conflicting/i);
  });

  it('recognizes an exact PromoStandards product-not-found response', () => {
    const missing = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ServiceMessageArray><ServiceMessage><code>130</code><description>Product Id not found</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:GetProductResponse></S:Body></S:Envelope>`;
    expect(parseSanMarProductLookupResponse(missing, { styleId: '2700' })).toEqual({ found: false });
  });

  it('rejects mixed or conflicting Product Data evidence', () => {
    const mixedMessages = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ServiceMessageArray><ServiceMessage><code>130</code><description>Product Id not found</description><severity>Error</severity></ServiceMessage><ServiceMessage><code>500</code><description>Internal failure</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:GetProductResponse></S:Body></S:Envelope>`;
    expect(() => parseSanMarProductLookupResponse(mixedMessages, { styleId: '2700' }))
      .toThrow(/could not confirm/i);

    const productAndMessage = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><Product><productId>K500</productId></Product><ServiceMessageArray><ServiceMessage><code>130</code><description>Product Id not found</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:GetProductResponse></S:Body></S:Envelope>`;
    expect(() => parseSanMarProductLookupResponse(productAndMessage, { styleId: 'K500' }))
      .toThrow(/conflicting/i);
  });

  it('reconciles an ambiguous Product Information error with Product Data not-found', async () => {
    const productError = PRODUCT_RESPONSE
      .replace('<errorOccured>false</errorOccured>', '<errorOccured>true</errorOccured>')
      .replace(/<listResponse>[\s\S]*<\/listResponse>/, '')
      .replace('Product Info sent successfully.', 'ERROR: Internal error occurred.');
    const missing = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ServiceMessageArray><ServiceMessage><code>130</code><description>Product Id not found</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:GetProductResponse></S:Body></S:Envelope>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(productError))
      .mockResolvedValueOnce(response(missing));
    const source = createSanMarSoapSource({
      customerNumber: 'customer', username: 'user', password: 'password',
      styleIds: ['2700'], fetch: fetchMock, sleep: vi.fn(), requestDelayMs: 0,
    });
    await expect(source.fetchStyle('2700')).resolves.toMatchObject({ styles: [], variants: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.SOAPAction).toBe('getProduct');
  });
});
