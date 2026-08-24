/**
 * Synthetic SanMar EPDD and DIP file content fixtures for testing.
 * Headers mirror the official SanMar Feb 2026 field names; row values are fake.
 */

import { Readable } from 'node:stream';

/**
 * Create a readable stream from a string (for testing parsers).
 */
export function streamFromString(content) {
  return Readable.from(content.split('\n').map(line => line + '\n'));
}

// --- EPDD Fixtures ---

export const EPDD_HEADERS = '"UNIQUE_KEY","PRODUCT_TITLE","PRODUCT_DESCRIPTION","STYLE#","CATEGORY_NAME","COLOR_NAME","SIZE","PIECE_PRICE","CASE_PRICE","INVENTORY_KEY","SIZE_INDEX","MILL","PRODUCT_STATUS","PRODUCT_IMAGE"';

export const EPDD_VALID_CONTENT = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-BLK-L","Silk Touch Polo","Classic polo","K500","Polos","Black","L","12.50","","INV002","S02","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-RED-S","Silk Touch Polo","Classic polo","K500","Polos","Red","S","12.50","","INV003","S03","Port Authority","Active","https://cdn.example.com/k500-red.jpg"
"PC61-NVY-M","Essential Tee","Basic tee","PC61","T-Shirts","Navy","M","5.25","","INV004","S04","Port & Company","Active","https://cdn.example.com/pc61.jpg"
"PC61-NVY-L","Essential Tee","Basic tee","PC61","T-Shirts","Navy","L","5.25","","INV005","S05","Port & Company","Active","https://cdn.example.com/pc61.jpg"
`;

export const EPDD_WITH_QUOTES = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch ""Premium"" Polo","A ""premium"" polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const EPDD_MISSING_HEADERS = `"UNIQUE_KEY","STYLE#","PRODUCT_TITLE"
"K500-BLK-M","K500","Silk Touch Polo"
`;

export const EPDD_EMPTY = '';

export const EPDD_DUPLICATE_CONFLICTING = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active",""
"K500-BLK-M","Different Style","","K501","Polos","Blue","L","13.00","","INV002","S02","Port Authority","Active",""
`;

export const EPDD_DUPLICATE_CATEGORY_MERGE = `${EPDD_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Uniforms","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","12.50","","INV001","S01","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

// --- DIP Fixtures ---

export const DIP_HEADERS = 'Inventory_Key|Size_Index|Catalog_No|Catalog_Color|Size|Whse_No|Quantity|Piece_Price|Dozens_Price|Case_Price|Case_Size|Each_sale_Price|Sale_start_datetime|Sale_end_datetime|Unique_key|Discontinued_code';

export const DIP_VALID_CONTENT = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25||9.50|2026-01-01|2026-12-31|K500-BLK-M|
INV001|S01|K500|Black|M|WH2|15|11.00|132.00|9.25||9.50|2026-01-01|2026-12-31|K500-BLK-M|
INV002|S02|K500|Black|L|WH1|30|11.00|132.00|9.25||9.50|2025-01-01|2025-06-30|K500-BLK-L|
INV003|S03|K500|Red|S|WH1|0|11.00|132.00|9.25|||||K500-RED-S|
INV004|S04|PC61|Navy|M|WH1|100|4.50|54.00|4.25|||||PC61-NVY-M|
INV005|S05|PC61|Navy|L|WH1|80|4.50|54.00|4.25|||||PC61-NVY-L|m
`;

export const DIP_DISCONTINUED = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|5|11.00|132.00|9.25|||||K500-BLK-M|s
`;

export const DIP_MISSING_HEADERS = `inventory_key|size_index|catalog_no
INV001|S01|K500
`;

export const DIP_EMPTY = '';

export const DIP_DUPLICATE_CONFLICTING = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25|||||K500-BLK-M|
INV002|S02|K501|Red|L|WH2|15|11.00|132.00|9.25|||||K500-BLK-M|
`;

// Expired sale (sale_end_date in the past relative to 2026-08-22)
export const DIP_EXPIRED_SALE = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25||9.50|2025-01-01|2025-06-30|K500-BLK-M|
`;

// Future sale (not yet started)
export const DIP_FUTURE_SALE = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|25|11.00|132.00|9.25||9.50|2027-01-01|2027-12-31|K500-BLK-M|
`;

// Zero inventory (should be preserved, not skipped)
export const DIP_ZERO_INVENTORY = `${DIP_HEADERS}
INV001|S01|K500|Black|M|WH1|0|11.00|132.00|9.25|||||K500-BLK-M|
`;

// --- SDL_N Fixtures ---

export const SDLN_HEADERS = '"UNIQUE_KEY","PRODUCT_TITLE","PRODUCT_DESCRIPTION","STYLE#","CATEGORY_NAME","COLOR_NAME","SIZE","PIECE_PRICE","DOZENS_PRICE","CASE_PRICE","INVENTORY_KEY","SIZE_INDEX","MILL","PRODUCT_STATUS","PRODUCT_IMAGE"';

export const SDLN_VALID_CONTENT = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-BLK-L","Silk Touch Polo","Classic polo","K500","Polos","Black","L","11.00","10.00","9.25","INV002","2","Port Authority","Regular","https://cdn.example.com/k500.jpg"
"PC61-NVY-M","Essential Tee","Basic tee","PC61","T-Shirts","Navy","M","4.50","4.35","4.25","INV004","1","Port & Company","New","https://cdn.example.com/pc61.jpg"
`;

export const SDLN_STATUS_CONTENT = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Regular","https://cdn.example.com/k500.jpg"
"K500-BLK-L","Silk Touch Polo","Classic polo","K500","Polos","Black","L","11.00","10.00","9.25","INV002","2","Port Authority","Coming soon","https://cdn.example.com/k500.jpg"
"K500-BLK-XL","Silk Touch Polo","Classic polo","K500","Polos","Black","XL","11.00","10.00","9.25","INV003","3","Port Authority","Discontinued","https://cdn.example.com/k500.jpg"
"K500-BLK-2XL","Silk Touch Polo","Classic polo","K500","Polos","Black","2XL","11.00","10.00","9.25","INV004","4","Port Authority","CloseOut","https://cdn.example.com/k500.jpg"
`;

export const SDLN_MISSING_HEADERS = `"UNIQUE_KEY","PRODUCT_TITLE","STYLE#","CASE_PRICE"
"K500-BLK-M","Silk Touch Polo","K500","9.25"
`;

export const SDLN_DUPLICATE_CASE_PRICE_HEADER = `"UNIQUE_KEY","PRODUCT_TITLE","PRODUCT_DESCRIPTION","STYLE#","CATEGORY_NAME","COLOR_NAME","SIZE","PIECE_PRICE","DOZENS_PRICE","CASE_PRICE","CASE_PRICE","INVENTORY_KEY","SIZE_INDEX","MILL","PRODUCT_STATUS","PRODUCT_IMAGE"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","8.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const SDLN_DUPLICATE_CANONICAL_ALIAS_HEADER = `"UNIQUE_KEY","PRODUCT_TITLE","PRODUCT_DESCRIPTION","STYLE#","CATEGORY_NAME","COLOR_NAME","SIZE","PIECE_PRICE","DOZENS_PRICE","CASE_PRICE","INVENTORY_KEY","SIZE_INDEX","MILL","PRODUCT_STATUS","PRODUCT_IMAGE","PRODUCT_IMAGE_URL"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg","https://cdn.example.com/k500-alt.jpg"
`;

export const SDLN_UNKNOWN_STATUS = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Maybe","https://cdn.example.com/k500.jpg"
`;

export const SDLN_MALFORMED_CASE_PRICE = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","USD 9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const SDLN_ZERO_CASE_PRICE = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","0","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const SDLN_DUPLICATE_CONFLICTING = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-BLK-M","Different Polo","Classic polo","K501","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const SDLN_DUPLICATE_IDENTICAL = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
"K500-BLK-M","Silk Touch Polo","Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;

export const SDLN_MALFORMED_CSV = `${SDLN_HEADERS}
"K500-BLK-M","Silk Touch Polo,"Classic polo","K500","Polos","Black","M","11.00","10.00","9.25","INV001","1","Port Authority","Active","https://cdn.example.com/k500.jpg"
`;
