/**
 * Synthetic S&S API response fixtures for testing.
 * No real vendor data or credentials.
 */

export const SS_STYLES_RESPONSE = [
  {
    styleID: 101,
    styleName: '3001',
    brandName: 'BELLA+CANVAS',
    title: 'Jersey Tee',
    categoryName: 'T-Shirts',
    description: 'Soft unisex tee',
    styleImage: 'https://cdn.example.com/3001.jpg',
  },
  {
    styleID: 102,
    styleName: '5000',
    brandName: 'Gildan',
    title: 'Heavy Cotton Tee',
    categoryName: 'T-Shirts',
    description: 'Classic heavy cotton',
    styleImage: 'https://cdn.example.com/5000.jpg',
  },
  {
    styleID: 103,
    styleName: '3001C',
    brandName: 'BELLA+CANVAS',
    title: 'Youth Jersey Tee',
    categoryName: 'T-Shirts',
    description: 'Youth version',
    styleImage: null,
  },
];

export const SS_PRODUCTS_BATCH_1 = [
  {
    styleID: 101,
    styleName: '3001',
    sku: 'SS-3001-BLK-S',
    colorName: 'Black',
    sizeName: 'S',
    qty: 42,
    customerPrice: 4.25,
    salePrice: 0,
    piecePrice: 5.50,
    colorImage: 'https://cdn.example.com/3001-blk.jpg',
  },
  {
    styleID: 101,
    styleName: '3001',
    sku: 'SS-3001-BLK-M',
    colorName: 'Black',
    sizeName: 'M',
    qty: 100,
    customerPrice: 4.25,
    salePrice: 3.99,
    piecePrice: 5.50,
    colorImage: 'https://cdn.example.com/3001-blk.jpg',
  },
  {
    styleID: 101,
    styleName: '3001',
    sku: 'SS-3001-WHT-L',
    colorName: 'White',
    sizeName: 'L',
    qty: 0,
    customerPrice: 0,
    salePrice: 0,
    piecePrice: 5.50,
    colorImage: null,
  },
  {
    styleID: 102,
    styleName: '5000',
    sku: 'SS-5000-RED-XL',
    colorName: 'Red',
    sizeName: 'XL',
    qty: 200,
    customerPrice: 3.10,
    salePrice: 0,
    piecePrice: 4.00,
    colorImage: 'https://cdn.example.com/5000-red.jpg',
  },
];

export const SS_PRODUCTS_BATCH_2 = [
  {
    styleID: 103,
    styleName: '3001C',
    sku: 'SS-3001C-BLU-YS',
    colorName: 'Blue',
    sizeName: 'YS',
    qty: 10,
    customerPrice: 3.90,
    salePrice: 0,
    piecePrice: 4.80,
    colorImage: null,
  },
];

// Product with no valid price (should be skipped)
export const SS_PRODUCT_NO_PRICE = {
  styleID: 101,
  styleName: '3001',
  sku: 'SS-3001-NOPRICE',
  colorName: 'Gray',
  sizeName: 'XXL',
  qty: 5,
  customerPrice: 0,
  salePrice: 0,
  piecePrice: 0,
  colorImage: null,
};

// Product with missing identity (should be skipped)
export const SS_PRODUCT_NO_SKU = {
  styleID: 101,
  styleName: '3001',
  sku: null,
  colorName: 'Navy',
  sizeName: 'M',
  qty: 10,
  customerPrice: 4.25,
  salePrice: 0,
  piecePrice: 5.50,
};

// Malformed JSON-like response
export const SS_MALFORMED_RESPONSE = '{"not": "an array"}';

// Style response with missing required fields
export const SS_STYLE_MISSING_FIELDS = { styleID: null, styleName: null };
