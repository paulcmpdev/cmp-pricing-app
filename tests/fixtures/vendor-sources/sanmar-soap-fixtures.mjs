export const SANMAR_SOAP_PRODUCT_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
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

export const SANMAR_SOAP_FAULT_RESPONSE = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Internal service failure</faultstring></S:Fault></S:Body></S:Envelope>`;

export const SANMAR_SOAP_NOT_FOUND_RESPONSE = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetProductResponse xmlns:ns2="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"><ServiceMessageArray><ServiceMessage><code>130</code><description>Product Id not found</description><severity>Error</severity></ServiceMessage></ServiceMessageArray></ns2:GetProductResponse></S:Body></S:Envelope>`;
