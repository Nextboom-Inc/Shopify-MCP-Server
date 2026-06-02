#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Config ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (
  !SHOPIFY_STORE_DOMAIN ||
  (!SHOPIFY_ACCESS_TOKEN && (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET))
) {
  console.error(
    'ERROR: Missing required environment variables. Required: SHOPIFY_STORE_DOMAIN plus either SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET'
  );
  process.exit(1);
}

const API_VERSION = '2026-01';
const BASE_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`;
const GRAPHQL_URL = `${BASE_URL}/graphql.json`;
const OAUTH_TOKEN_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

let tokenCache = {
  accessToken: SHOPIFY_ACCESS_TOKEN || null,
  expiresAtMs: SHOPIFY_ACCESS_TOKEN ? Number.MAX_SAFE_INTEGER : 0,
};

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAtMs - 30000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Shopify OAuth ${res.status}: ${responseBody}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Shopify OAuth response missing access_token');
  }

  tokenCache = {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + (Number(json.expires_in || 3600) * 1000),
  };
  return tokenCache.accessToken;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────
async function shopifyREST(path, options = {}) {
  const accessToken = await getAccessToken();
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify REST ${res.status} on ${path}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function shopifyGQL(query, variables = {}) {
  const accessToken = await getAccessToken();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function ok(data) {
  return { success: true, data };
}

function err(message) {
  return { success: false, error: message };
}

const tools = [
  {
    name: 'get_product',
    description: 'Fetch a single product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'list_products',
    description: 'List products with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results (default 50, max 250)',
        },
        title: { type: 'string', description: 'Filter by title' },
        product_type: {
          type: 'string',
          description: 'Filter by product type',
        },
        vendor: { type: 'string', description: 'Filter by vendor' },
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'archived', 'draft'],
        },
        collection_id: {
          type: 'string',
          description: 'Filter by collection ID',
        },
      },
    },
  },
  {
    name: 'create_product',
    description: 'Create a new product with optional variants, images, metafields, and tags',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Product title (required)' },
        body_html: { type: 'string', description: 'Product description (HTML)' },
        vendor: { type: 'string', description: 'Product vendor' },
        product_type: { type: 'string', description: 'Product type' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        status: {
          type: 'string',
          description: 'Product status',
          enum: ['active', 'draft', 'archived'],
        },
        variants: {
          type: 'array',
          description: 'List of variants',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              price: { type: 'string' },
              sku: { type: 'string' },
              barcode: { type: 'string' },
              compare_at_price: { type: 'string' },
              inventory_quantity: { type: 'number' },
              taxable: { type: 'boolean' },
              requires_shipping: { type: 'boolean' },
              weight: { type: 'number' },
              weight_unit: { type: 'string' },
              option1: { type: 'string' },
              option2: { type: 'string' },
              option3: { type: 'string' },
            },
          },
        },
        options: {
          type: 'array',
          description: 'Product options (e.g. Size, Color)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
        images: {
          type: 'array',
          description: 'Product images',
          items: {
            type: 'object',
            properties: {
              src: { type: 'string', description: 'Image URL' },
              alt: { type: 'string' },
            },
          },
        },
        metafields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              namespace: { type: 'string' },
              key: { type: 'string' },
              value: { type: 'string' },
              type: { type: 'string' },
            },
          },
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_product',
    description: 'Update an existing product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID (required)',
        },
        title: { type: 'string', description: 'Product title' },
        body_html: { type: 'string', description: 'Product description (HTML)' },
        vendor: { type: 'string', description: 'Product vendor' },
        product_type: { type: 'string', description: 'Product type' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        status: {
          type: 'string',
          description: 'Product status',
          enum: ['active', 'draft', 'archived'],
        },
        product_taxonomy_node_id: {
          type: 'string',
          description: 'Shopify standard product category GID (e.g. "gid://shopify/TaxonomyCategory/sg-4-17-2-17")',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'set_product_category',
    description: 'Set product category using Shopify standard taxonomy (GraphQL)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID (numeric ID or GID)',
        },
        taxonomy_node_id: {
          type: 'string',
          description: 'Shopify standard product category GID (e.g. "gid://shopify/TaxonomyCategory/sg-4-17-2-17")',
        },
      },
      required: ['product_id', 'taxonomy_node_id'],
    },
  },
  {
    name: 'delete_product',
    description: 'Delete a product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'publish_product',
    description: 'Publish or unpublish a product (set status to active or draft)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        published: {
          type: 'boolean',
          description: 'true = active, false = draft',
        },
      },
      required: ['product_id', 'published'],
    },
  },
  {
    name: 'list_product_variants',
    description: 'List all variants for a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'create_product_variant',
    description: 'Add a new variant to a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        price: { type: 'string', description: 'Variant price (required)' },
        title: { type: 'string', description: 'Variant title' },
        sku: { type: 'string', description: 'Stock keeping unit' },
        barcode: { type: 'string', description: 'Barcode' },
        compare_at_price: { type: 'string', description: 'Compare at price' },
        inventory_quantity: { type: 'number', description: 'Inventory quantity' },
        taxable: { type: 'boolean', description: 'Whether item is taxable' },
        requires_shipping: {
          type: 'boolean',
          description: 'Whether shipping is required',
        },
        weight: { type: 'number', description: 'Weight' },
        weight_unit: { type: 'string', description: 'Weight unit' },
        option1: { type: 'string', description: 'Option 1 value' },
        option2: { type: 'string', description: 'Option 2 value' },
        option3: { type: 'string', description: 'Option 3 value' },
      },
      required: ['product_id', 'price'],
    },
  },
  {
    name: 'update_product_variant',
    description: 'Update an existing product variant',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: {
          type: 'string',
          description: 'The variant ID (required)',
        },
        price: { type: 'string', description: 'Variant price' },
        title: { type: 'string', description: 'Variant title' },
        sku: { type: 'string', description: 'Stock keeping unit' },
        barcode: { type: 'string', description: 'Barcode' },
        compare_at_price: { type: 'string', description: 'Compare at price' },
        taxable: { type: 'boolean', description: 'Whether item is taxable' },
        requires_shipping: {
          type: 'boolean',
          description: 'Whether shipping is required',
        },
        weight: { type: 'number', description: 'Weight' },
        weight_unit: { type: 'string', description: 'Weight unit' },
        option1: { type: 'string', description: 'Option 1 value' },
        option2: { type: 'string', description: 'Option 2 value' },
        option3: { type: 'string', description: 'Option 3 value' },
      },
      required: ['variant_id'],
    },
  },
  {
    name: 'delete_product_variant',
    description: 'Delete a variant from a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        variant_id: { type: 'string', description: 'The variant ID' },
      },
      required: ['product_id', 'variant_id'],
    },
  },
  {
    name: 'get_product_metafields',
    description: 'Get all metafields for a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        namespace: { type: 'string', description: 'Filter by namespace' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'set_product_metafield',
    description: 'Create or update a metafield on a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        namespace: { type: 'string', description: 'Metafield namespace' },
        key: { type: 'string', description: 'Metafield key' },
        value: { type: 'string', description: 'Metafield value' },
        type: {
          type: 'string',
          description: 'Metafield type (e.g. single_line_text_field, number_integer, json)',
        },
      },
      required: ['product_id', 'namespace', 'key', 'value', 'type'],
    },
  },
  {
    name: 'add_product_image',
    description: 'Add an image to a product by URL',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        src: { type: 'string', description: 'Image URL (required)' },
        alt: { type: 'string', description: 'Alt text' },
        variant_ids: {
          type: 'array',
          description: 'Associate image with specific variants',
          items: { type: 'number' },
        },
      },
      required: ['product_id', 'src'],
    },
  },
  {
    name: 'list_collections',
    description: 'List all custom and smart collections',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results' },
        title: { type: 'string', description: 'Filter by title' },
      },
    },
  },
  {
    name: 'get_collection',
    description: 'Get a collection by ID',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string', description: 'The collection ID' },
      },
      required: ['collection_id'],
    },
  },
  {
    name: 'create_collection',
    description: 'Create a custom collection',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Collection title (required)' },
        body_html: { type: 'string', description: 'Collection description' },
        image_src: { type: 'string', description: 'Collection image URL' },
        sort_order: {
          type: 'string',
          description: 'Sort order',
          enum: [
            'alpha-asc',
            'alpha-desc',
            'best-selling',
            'created',
            'created-desc',
            'manual',
            'price-asc',
            'price-desc',
          ],
        },
        published: { type: 'boolean', description: 'Publish the collection' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_collection',
    description: 'Update a custom collection',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: {
          type: 'string',
          description: 'The collection ID (required)',
        },
        title: { type: 'string', description: 'Collection title' },
        body_html: { type: 'string', description: 'Collection description' },
        sort_order: { type: 'string', description: 'Sort order' },
        published: { type: 'boolean', description: 'Publish the collection' },
      },
      required: ['collection_id'],
    },
  },
  {
    name: 'add_product_to_collection',
    description: 'Add a product to a custom collection',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string', description: 'The collection ID' },
        product_id: { type: 'string', description: 'The product ID' },
      },
      required: ['collection_id', 'product_id'],
    },
  },
  {
    name: 'list_collection_products',
    description: 'List products in a collection',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string', description: 'The collection ID' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['collection_id'],
    },
  },
  {
    name: 'list_orders',
    description: 'List orders with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Order status',
          enum: ['open', 'closed', 'cancelled', 'any'],
        },
        financial_status: {
          type: 'string',
          description: 'Financial status',
          enum: [
            'authorized',
            'pending',
            'paid',
            'partially_paid',
            'refunded',
            'voided',
            'any',
          ],
        },
        fulfillment_status: {
          type: 'string',
          description: 'Fulfillment status',
          enum: ['shipped', 'partial', 'unshipped', 'unfulfilled', 'any'],
        },
        customer_id: {
          type: 'string',
          description: 'Filter by customer ID',
        },
        created_at_min: {
          type: 'string',
          description: 'ISO 8601 date',
        },
        created_at_max: {
          type: 'string',
          description: 'ISO 8601 date',
        },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'get_order',
    description: 'Get a single order by ID with full details',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'create_order',
    description: 'Create a new order',
    inputSchema: {
      type: 'object',
      properties: {
        line_items: {
          type: 'array',
          description: 'Order line items (required)',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'number' },
              variant_id: { type: 'number' },
              quantity: { type: 'number' },
              title: { type: 'string' },
              price: { type: 'string' },
            },
          },
        },
        customer: {
          type: 'object',
          description: 'Customer object',
          properties: {
            id: { type: 'number' },
            email: { type: 'string' },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
          },
        },
        shipping_address: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            address1: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            zip: { type: 'string' },
            country: { type: 'string' },
          },
        },
        note: { type: 'string', description: 'Order note' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        financial_status: { type: 'string', description: 'Financial status' },
        send_receipt: {
          type: 'boolean',
          description: 'Send receipt to customer',
        },
      },
      required: ['line_items'],
    },
  },
  {
    name: 'update_order',
    description: 'Update an existing order (note, tags, email, shipping address)',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID (required)',
        },
        email: { type: 'string', description: 'Customer email' },
        note: { type: 'string', description: 'Order note' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        shipping_address: {
          type: 'object',
          description: 'Shipping address',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel an order',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID (required)',
        },
        reason: {
          type: 'string',
          description: 'Cancel reason',
          enum: ['customer', 'fraud', 'inventory', 'declined', 'other'],
        },
        refund: { type: 'boolean', description: 'Refund payment' },
        restock: { type: 'boolean', description: 'Restock inventory' },
        email: {
          type: 'boolean',
          description: 'Send cancellation email to customer',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'close_order',
    description: 'Close an order (mark as completed)',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'fulfill_order',
    description: 'Create a fulfillment for an order',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID (required)',
        },
        location_id: {
          type: 'string',
          description: 'Location ID for fulfillment',
        },
        line_items: {
          type: 'array',
          description: 'Specific line items to fulfill (omit to fulfill all)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              quantity: { type: 'number' },
            },
          },
        },
        tracking_company: { type: 'string', description: 'Tracking company' },
        tracking_number: { type: 'string', description: 'Tracking number' },
        tracking_url: { type: 'string', description: 'Tracking URL' },
        notify_customer: {
          type: 'boolean',
          description: 'Notify customer of fulfillment',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'create_refund',
    description: 'Create a refund for an order',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID (required)',
        },
        refund_line_items: {
          type: 'array',
          description: 'Line items to refund',
          items: {
            type: 'object',
            properties: {
              line_item_id: { type: 'number' },
              quantity: { type: 'number' },
              location_id: { type: 'number' },
              restock_type: {
                type: 'string',
                enum: ['no_restock', 'cancel', 'return', 'legacy_restock'],
              },
            },
          },
        },
        shipping: {
          type: 'object',
          properties: {
            full_refund: { type: 'boolean' },
            amount: { type: 'string' },
          },
        },
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['refund'] },
              gateway: { type: 'string' },
              amount: { type: 'string' },
              parent_id: { type: 'number' },
            },
          },
        },
        note: { type: 'string', description: 'Refund note' },
        notify: { type: 'boolean', description: 'Notify customer' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'get_order_transactions',
    description: 'Get all transactions for an order',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order ID' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'list_draft_orders',
    description: 'List draft orders',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Draft order status',
          enum: ['open', 'invoice_sent', 'completed', 'any'],
        },
        limit: { type: 'number', description: 'Max results' },
      },
    },
  },
  {
    name: 'create_draft_order',
    description: 'Create a draft order',
    inputSchema: {
      type: 'object',
      properties: {
        line_items: {
          type: 'array',
          description: 'Order line items (required)',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'number' },
              quantity: { type: 'number' },
              title: { type: 'string' },
              price: { type: 'string' },
            },
          },
        },
        customer: {
          type: 'object',
          description: 'Customer object',
        },
        shipping_address: {
          type: 'object',
          description: 'Shipping address',
        },
        discount: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            value_type: {
              type: 'string',
              enum: ['fixed_amount', 'percentage'],
            },
            value: { type: 'string' },
          },
        },
        note: { type: 'string', description: 'Draft order note' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['line_items'],
    },
  },
  {
    name: 'complete_draft_order',
    description: 'Complete a draft order (converts to an order)',
    inputSchema: {
      type: 'object',
      properties: {
        draft_order_id: {
          type: 'string',
          description: 'The draft order ID (required)',
        },
        payment_gateway: {
          type: 'string',
          description: 'Payment gateway',
        },
      },
      required: ['draft_order_id'],
    },
  },
  {
    name: 'list_customers',
    description: 'List customers',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results' },
        created_at_min: { type: 'string', description: 'ISO 8601 date' },
        created_at_max: { type: 'string', description: 'ISO 8601 date' },
        updated_at_min: { type: 'string', description: 'ISO 8601 date' },
      },
    },
  },
  {
    name: 'search_customers',
    description: 'Search customers by name, email, or phone',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "email:foo@bar.com" or "John Smith")',
        },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_customer',
    description: 'Get a customer by ID',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'The customer ID' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'create_customer',
    description: 'Create a new customer',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email (required)' },
        first_name: { type: 'string', description: 'First name' },
        last_name: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        note: { type: 'string', description: 'Customer note' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        accepts_marketing: { type: 'boolean', description: 'Accepts marketing' },
        verified_email: { type: 'boolean', description: 'Email verified' },
        addresses: {
          type: 'array',
          description: 'Customer addresses',
          items: {
            type: 'object',
            properties: {
              address1: { type: 'string' },
              city: { type: 'string' },
              province: { type: 'string' },
              zip: { type: 'string' },
              country: { type: 'string' },
              phone: { type: 'string' },
            },
          },
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_customer',
    description: 'Update an existing customer',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'The customer ID (required)',
        },
        email: { type: 'string', description: 'Customer email' },
        first_name: { type: 'string', description: 'First name' },
        last_name: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        note: { type: 'string', description: 'Customer note' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        accepts_marketing: { type: 'boolean', description: 'Accepts marketing' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'delete_customer',
    description: 'Delete a customer by ID',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'The customer ID' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_customer_orders',
    description: 'Get all orders for a specific customer',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'The customer ID' },
        limit: { type: 'number', description: 'Max results' },
        status: { type: 'string', description: 'Order status' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'list_locations',
    description: 'List all fulfillment locations for the store',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_inventory_levels',
    description: 'Get inventory levels (filter by location or inventory item)',
    inputSchema: {
      type: 'object',
      properties: {
        location_ids: {
          type: 'string',
          description: 'Comma-separated location IDs',
        },
        inventory_item_ids: {
          type: 'string',
          description: 'Comma-separated inventory item IDs',
        },
        limit: { type: 'number', description: 'Max results' },
      },
    },
  },
  {
    name: 'adjust_inventory',
    description: 'Adjust inventory quantity for an item at a location (relative adjustment)',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Location ID' },
        inventory_item_id: { type: 'string', description: 'Inventory item ID' },
        available_adjustment: {
          type: 'number',
          description: 'Positive to add, negative to subtract',
        },
      },
      required: ['location_id', 'inventory_item_id', 'available_adjustment'],
    },
  },
  {
    name: 'set_inventory_level',
    description: 'Set absolute inventory quantity for an item at a location',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Location ID' },
        inventory_item_id: { type: 'string', description: 'Inventory item ID' },
        available: {
          type: 'number',
          description: 'Absolute quantity to set',
        },
      },
      required: ['location_id', 'inventory_item_id', 'available'],
    },
  },
  {
    name: 'update_inventory_item',
    description: 'Update an inventory item (HS code, country of origin, tracking, cost, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        inventory_item_id: {
          type: 'string',
          description: 'The inventory item ID (numeric)',
        },
        harmonized_system_code: {
          type: 'string',
          description: 'HS (Harmonized System) tariff code for customs (e.g. "9405421000")',
        },
        country_code_of_origin: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code where the item was manufactured (e.g. "CN", "US")',
        },
        province_code_of_origin: {
          type: 'string',
          description: 'Province/state code of origin (e.g. "CA" for California)',
        },
        tracked: {
          type: 'boolean',
          description: 'Whether inventory is tracked for this item',
        },
        cost: {
          type: 'string',
          description: 'Unit cost of the item (e.g. "25.00")',
        },
      },
      required: ['inventory_item_id'],
    },
  },
  {
    name: 'list_price_rules',
    description: 'List all price rules (discount types)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results' },
      },
    },
  },
  {
    name: 'create_price_rule',
    description: 'Create a price rule (basis for discount codes)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Price rule title' },
        value_type: {
          type: 'string',
          description: 'Discount type',
          enum: ['fixed_amount', 'percentage'],
        },
        value: {
          type: 'string',
          description: 'Negative number, e.g. "-10.0" for $10 off or "-25.0" for 25% off',
        },
        customer_selection: {
          type: 'string',
          description: 'Customer selection type',
          enum: ['all', 'prerequisite'],
        },
        target_type: {
          type: 'string',
          description: 'Target type',
          enum: ['line_item', 'shipping_line'],
        },
        target_selection: {
          type: 'string',
          description: 'Target selection',
          enum: ['all', 'entitled'],
        },
        allocation_method: {
          type: 'string',
          description: 'How discount is applied',
          enum: ['each', 'across'],
        },
        starts_at: { type: 'string', description: 'ISO 8601 datetime' },
        ends_at: { type: 'string', description: 'ISO 8601 datetime (optional)' },
        usage_limit: {
          type: 'number',
          description: 'Total uses allowed (optional)',
        },
        once_per_customer: {
          type: 'boolean',
          description: 'Limit to once per customer',
        },
        minimum_amount: {
          type: 'string',
          description: 'Minimum order amount required',
        },
      },
      required: [
        'title',
        'value_type',
        'value',
        'customer_selection',
        'target_type',
        'target_selection',
        'allocation_method',
        'starts_at',
      ],
    },
  },
  {
    name: 'create_discount_code',
    description: 'Create a discount code for an existing price rule',
    inputSchema: {
      type: 'object',
      properties: {
        price_rule_id: { type: 'string', description: 'Price rule ID' },
        code: {
          type: 'string',
          description: 'Discount code string (e.g. SAVE20)',
        },
      },
      required: ['price_rule_id', 'code'],
    },
  },
  {
    name: 'list_discount_codes',
    description: 'List discount codes for a price rule',
    inputSchema: {
      type: 'object',
      properties: {
        price_rule_id: { type: 'string', description: 'Price rule ID' },
      },
      required: ['price_rule_id'],
    },
  },
  {
    name: 'delete_discount_code',
    description: 'Delete a discount code',
    inputSchema: {
      type: 'object',
      properties: {
        price_rule_id: { type: 'string', description: 'Price rule ID' },
        discount_code_id: { type: 'string', description: 'Discount code ID' },
      },
      required: ['price_rule_id', 'discount_code_id'],
    },
  },
  {
    name: 'list_metaobject_definitions',
    description: 'List all metaobject definitions in the store',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results' },
      },
    },
  },
  {
    name: 'create_metaobject_definition',
    description: 'Create a new metaobject definition (custom content type)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (required)' },
        type: {
          type: 'string',
          description: 'Type handle (required)',
        },
        description: { type: 'string', description: 'Description' },
        fields: {
          type: 'array',
          description: 'Field definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              key: { type: 'string' },
              description: { type: 'string' },
              type: { type: 'string' },
              required: { type: 'boolean' },
            },
          },
        },
      },
      required: ['name', 'type', 'fields'],
    },
  },
  {
    name: 'list_metaobjects',
    description: 'List metaobjects of a given type',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Metaobject type handle' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['type'],
    },
  },
  {
    name: 'create_metaobject',
    description: 'Create a new metaobject entry',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Metaobject type handle' },
        fields: {
          type: 'array',
          description: 'Field values',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        handle: { type: 'string', description: 'Optional unique handle/slug' },
        capabilities: {
          type: 'object',
          description: 'Capabilities like publishable status',
          properties: {
            publishable: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['ACTIVE', 'DRAFT'],
                },
              },
            },
          },
        },
      },
      required: ['type', 'fields'],
    },
  },
  {
    name: 'update_metaobject',
    description: 'Update fields on an existing metaobject',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Metaobject GID (gid://shopify/Metaobject/...)',
        },
        fields: {
          type: 'array',
          description: 'Field values to update',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
      required: ['id', 'fields'],
    },
  },
  {
    name: 'delete_metaobject',
    description: 'Delete a metaobject by GID',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Metaobject GID (gid://shopify/Metaobject/...)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_product_taxonomy',
    description: 'List all product categories in Shopify\'s standard taxonomy',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_publications',
    description: 'List all sales channels / publications the store has enabled',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'publish_product_to_channel',
    description: 'Publish a product to one or more sales channels',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        publication_ids: {
          type: 'string',
          description: 'Comma-separated publication IDs',
        },
      },
      required: ['product_id', 'publication_ids'],
    },
  },
  {
    name: 'unpublish_product_from_channel',
    description: 'Remove a product from a specific sales channel (publication)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        publication_id: { type: 'string', description: 'The publication ID' },
      },
      required: ['product_id', 'publication_id'],
    },
  },
  {
    name: 'get_shop_info',
    description: 'Get store information (name, domain, currency, plan, contact email, etc.)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'add_product_image_base64',
    description: 'Upload an image and attach it to a product. Accepts either a local file path or a base64-encoded string (uses Shopify staged uploads)',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The product ID (numeric or GID)',
        },
        file_path: {
          type: 'string',
          description: 'Absolute path to an image file on disk (e.g. "/Users/sean/images/sign.png"). Alternative to base64_image.',
        },
        base64_image: {
          type: 'string',
          description: 'The base64-encoded image data (no data:image prefix). Alternative to file_path.',
        },
        filename: {
          type: 'string',
          description: 'Filename for the image (e.g. "photo.png"). Auto-detected from file_path if omitted.',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type (e.g. "image/png", "image/jpeg"). Auto-detected from file_path if omitted.',
        },
        alt_text: {
          type: 'string',
          description: 'Alt text for the image (optional)',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'set_variant_metafield',
    description: 'Set or update metafields on product variants. Supports batching: pass a single metafield (variant_id + namespace/key/type/value) OR an array of metafields to set up to 25 at once across multiple variants.',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: {
          type: 'string',
          description: 'The variant ID (numeric or GID). Used for single metafield mode.',
        },
        namespace: {
          type: 'string',
          description: 'Metafield namespace (e.g. "custom"). Used for single metafield mode.',
        },
        key: {
          type: 'string',
          description: 'Metafield key (e.g. "material"). Used for single metafield mode.',
        },
        type: {
          type: 'string',
          description: 'Metafield type (e.g. "single_line_text_field", "number_integer", "json", "boolean"). Used for single metafield mode.',
        },
        value: {
          type: 'string',
          description: 'Metafield value (must be a string). Used for single metafield mode.',
        },
        metafields: {
          type: 'array',
          description: 'Batch mode: array of metafield objects, each with variant_id, namespace, key, type, value. Max 25 per call. Can span multiple variants.',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'string' },
              namespace: { type: 'string' },
              key: { type: 'string' },
              type: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['variant_id', 'namespace', 'key', 'type', 'value'],
          },
        },
      },
    },
  },
  // ─── Themes ──────────────────────────────────────────────────────────────────
  {
    name: 'list_themes',
    description: 'List all themes in the store',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_theme',
    description: 'Get a theme by ID',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
      },
      required: ['theme_id'],
    },
  },
  {
    name: 'create_theme',
    description: 'Create a new theme (from a ZIP URL or blank)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Theme name (required)' },
        src: { type: 'string', description: 'URL of a .zip file containing the theme (optional)' },
        role: {
          type: 'string',
          description: 'Theme role: "main" (published), "unpublished", or "demo"',
          enum: ['main', 'unpublished', 'demo'],
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_theme',
    description: 'Update a theme (name or role)',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID (required)' },
        name: { type: 'string', description: 'New theme name' },
        role: {
          type: 'string',
          description: 'Theme role: "main" (publishes it), "unpublished", or "demo"',
          enum: ['main', 'unpublished', 'demo'],
        },
      },
      required: ['theme_id'],
    },
  },
  {
    name: 'delete_theme',
    description: 'Delete a theme by ID (cannot delete the published theme)',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
      },
      required: ['theme_id'],
    },
  },
  // ─── Theme Assets (Files) ────────────────────────────────────────────────────
  {
    name: 'list_theme_assets',
    description: 'List all asset file paths in a theme (returns keys only, not file contents)',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
      },
      required: ['theme_id'],
    },
  },
  {
    name: 'get_theme_asset',
    description: 'Read a single theme file by its key (e.g. "templates/index.json", "sections/header.liquid")',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
        key: { type: 'string', description: 'Asset key / file path (e.g. "layout/theme.liquid", "config/settings_data.json")' },
      },
      required: ['theme_id', 'key'],
    },
  },
  {
    name: 'put_theme_asset',
    description: 'Create or update a theme file. Provide either "value" (file content as string) or "src" (public URL to download from). For binary files like images, use "src".',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
        key: { type: 'string', description: 'Asset key / file path (e.g. "sections/custom.liquid")' },
        value: { type: 'string', description: 'File content as a string (for text files like .liquid, .json, .css, .js)' },
        src: { type: 'string', description: 'Public URL to download the file from (for images or any file type)' },
      },
      required: ['theme_id', 'key'],
    },
  },
  {
    name: 'delete_theme_asset',
    description: 'Delete a theme file by key',
    inputSchema: {
      type: 'object',
      properties: {
        theme_id: { type: 'string', description: 'The theme ID' },
        key: { type: 'string', description: 'Asset key / file path to delete' },
      },
      required: ['theme_id', 'key'],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────
const handlers = {
  get_product: async (args) => {
    try {
      const product = await shopifyREST(`/products/${args.product_id}.json`);
      return ok(product);
    } catch (error) {
      return err(error.message);
    }
  },

  list_products: async (args) => {
    try {
      let url = '/products.json?';
      const params = [];
      if (args.limit) params.push(`limit=${args.limit}`);
      if (args.title) params.push(`title=${encodeURIComponent(args.title)}`);
      if (args.product_type)
        params.push(`product_type=${encodeURIComponent(args.product_type)}`);
      if (args.vendor) params.push(`vendor=${encodeURIComponent(args.vendor)}`);
      if (args.status) params.push(`status=${args.status}`);
      if (args.collection_id)
        params.push(`collection_id=${args.collection_id}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.products || []);
    } catch (error) {
      return err(error.message);
    }
  },

  create_product: async (args) => {
    try {
      const product = {
        title: args.title,
        body_html: args.body_html,
        vendor: args.vendor,
        product_type: args.product_type,
        tags: args.tags,
        status: args.status,
        variants: args.variants,
        options: args.options,
        images: args.images,
        metafields: args.metafields,
      };

      const result = await shopifyREST('/products.json', {
        method: 'POST',
        body: JSON.stringify({ product }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_product: async (args) => {
    try {
      const product = {};
      if (args.title) product.title = args.title;
      if (args.body_html) product.body_html = args.body_html;
      if (args.vendor) product.vendor = args.vendor;
      if (args.product_type) product.product_type = args.product_type;
      if (args.tags) product.tags = args.tags;
      if (args.status) product.status = args.status;
      if (args.product_taxonomy_node_id)
        product.product_taxonomy_node_id = args.product_taxonomy_node_id;

      const result = await shopifyREST(
        `/products/${args.product_id}.json`,
        {
          method: 'PUT',
          body: JSON.stringify({ product }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  set_product_category: async (args) => {
    try {
      // Extract numeric ID from product_id if it contains slashes (GID format)
      let numericId = args.product_id;
      if (args.product_id.includes('/')) {
        const parts = args.product_id.split('/');
        numericId = parts[parts.length - 1];
      }

      const mutation = `
        mutation SetProductCategory($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              title
              productType
              category {
                id
                name
                fullName
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        product: {
          id: `gid://shopify/Product/${numericId}`,
          category: args.taxonomy_node_id,
        },
      };

      const result = await shopifyGQL(mutation, variables);
      if (result.productUpdate?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.productUpdate.userErrors)}`
        );
      }
      return { success: true, data: { id: result.productUpdate.product?.id, category: result.productUpdate.product?.category?.name } };
    } catch (error) {
      return err(error.message);
    }
  },

  delete_product: async (args) => {
    try {
      await shopifyREST(`/products/${args.product_id}.json`, {
        method: 'DELETE',
      });
      return ok({ message: 'Product deleted' });
    } catch (error) {
      return err(error.message);
    }
  },

  publish_product: async (args) => {
    try {
      const status = args.published ? 'active' : 'draft';
      const result = await shopifyREST(
        `/products/${args.product_id}.json`,
        {
          method: 'PUT',
          body: JSON.stringify({ product: { status } }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  list_product_variants: async (args) => {
    try {
      const data = await shopifyREST(
        `/products/${args.product_id}/variants.json${args.limit ? `?limit=${args.limit}` : ''}`
      );
      return ok(data.variants || []);
    } catch (error) {
      return err(error.message);
    }
  },

  create_product_variant: async (args) => {
    try {
      const variant = {
        price: args.price,
        title: args.title,
        sku: args.sku,
        barcode: args.barcode,
        compare_at_price: args.compare_at_price,
        inventory_quantity: args.inventory_quantity,
        taxable: args.taxable,
        requires_shipping: args.requires_shipping,
        weight: args.weight,
        weight_unit: args.weight_unit,
        option1: args.option1,
        option2: args.option2,
        option3: args.option3,
      };

      const result = await shopifyREST(
        `/products/${args.product_id}/variants.json`,
        {
          method: 'POST',
          body: JSON.stringify({ variant }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_product_variant: async (args) => {
    try {
      const variant = {};
      if (args.price) variant.price = args.price;
      if (args.title) variant.title = args.title;
      if (args.sku) variant.sku = args.sku;
      if (args.barcode) variant.barcode = args.barcode;
      if (args.compare_at_price) variant.compare_at_price = args.compare_at_price;
      if (args.taxable !== undefined) variant.taxable = args.taxable;
      if (args.requires_shipping !== undefined)
        variant.requires_shipping = args.requires_shipping;
      if (args.weight) variant.weight = args.weight;
      if (args.weight_unit) variant.weight_unit = args.weight_unit;
      if (args.option1) variant.option1 = args.option1;
      if (args.option2) variant.option2 = args.option2;
      if (args.option3) variant.option3 = args.option3;

      const result = await shopifyREST(`/variants/${args.variant_id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ variant }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  delete_product_variant: async (args) => {
    try {
      await shopifyREST(
        `/products/${args.product_id}/variants/${args.variant_id}.json`,
        { method: 'DELETE' }
      );
      return ok({ message: 'Variant deleted' });
    } catch (error) {
      return err(error.message);
    }
  },

  get_product_metafields: async (args) => {
    try {
      let url = `/products/${args.product_id}/metafields.json`;
      if (args.namespace) url += `?namespace=${encodeURIComponent(args.namespace)}`;
      const data = await shopifyREST(url);
      return ok(data.metafields || []);
    } catch (error) {
      return err(error.message);
    }
  },

  set_product_metafield: async (args) => {
    try {
      const metafield = {
        namespace: args.namespace,
        key: args.key,
        value: args.value,
        type: args.type,
      };
      await shopifyREST(
        `/products/${args.product_id}/metafields.json`,
        {
          method: 'POST',
          body: JSON.stringify({ metafield }),
        }
      );
      return { success: true, data: { namespace: args.namespace, key: args.key } };
    } catch (error) {
      return err(error.message);
    }
  },

  add_product_image: async (args) => {
    try {
      const image = { src: args.src, alt: args.alt };
      if (args.variant_ids) image.variant_ids = args.variant_ids;

      const result = await shopifyREST(
        `/products/${args.product_id}/images.json`,
        {
          method: 'POST',
          body: JSON.stringify({ image }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  list_collections: async (args) => {
    try {
      let url = '/custom_collections.json?';
      const params = [];
      if (args.limit) params.push(`limit=${args.limit}`);
      if (args.title) params.push(`title=${encodeURIComponent(args.title)}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.custom_collections || []);
    } catch (error) {
      return err(error.message);
    }
  },

  get_collection: async (args) => {
    try {
      const data = await shopifyREST(`/custom_collections/${args.collection_id}.json`);
      return ok(data.custom_collection);
    } catch (error) {
      return err(error.message);
    }
  },

  create_collection: async (args) => {
    try {
      const custom_collection = {
        title: args.title,
        body_html: args.body_html,
        image: args.image_src ? { src: args.image_src } : undefined,
        sort_order: args.sort_order,
        published: args.published,
      };
      const result = await shopifyREST('/custom_collections.json', {
        method: 'POST',
        body: JSON.stringify({ custom_collection }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_collection: async (args) => {
    try {
      const custom_collection = {};
      if (args.title) custom_collection.title = args.title;
      if (args.body_html) custom_collection.body_html = args.body_html;
      if (args.sort_order) custom_collection.sort_order = args.sort_order;
      if (args.published !== undefined) custom_collection.published = args.published;

      const result = await shopifyREST(
        `/custom_collections/${args.collection_id}.json`,
        {
          method: 'PUT',
          body: JSON.stringify({ custom_collection }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  add_product_to_collection: async (args) => {
    try {
      const result = await shopifyREST(
        `/custom_collections/${args.collection_id}/products/${args.product_id}.json`,
        { method: 'PUT', body: JSON.stringify({}) }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  list_collection_products: async (args) => {
    try {
      const data = await shopifyREST(
        `/custom_collections/${args.collection_id}/products.json${args.limit ? `?limit=${args.limit}` : ''}`
      );
      return ok(data.products || []);
    } catch (error) {
      return err(error.message);
    }
  },

  list_orders: async (args) => {
    try {
      let url = '/orders.json?';
      const params = [];
      if (args.status) params.push(`status=${args.status}`);
      if (args.financial_status) params.push(`financial_status=${args.financial_status}`);
      if (args.fulfillment_status)
        params.push(`fulfillment_status=${args.fulfillment_status}`);
      if (args.customer_id) params.push(`customer_id=${args.customer_id}`);
      if (args.created_at_min) params.push(`created_at_min=${args.created_at_min}`);
      if (args.created_at_max) params.push(`created_at_max=${args.created_at_max}`);
      if (args.limit) params.push(`limit=${args.limit}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.orders || []);
    } catch (error) {
      return err(error.message);
    }
  },

  get_order: async (args) => {
    try {
      const data = await shopifyREST(`/orders/${args.order_id}.json`);
      return ok(data.order);
    } catch (error) {
      return err(error.message);
    }
  },

  create_order: async (args) => {
    try {
      const order = {
        line_items: args.line_items,
        customer: args.customer,
        shipping_address: args.shipping_address,
        note: args.note,
        tags: args.tags,
        financial_status: args.financial_status,
        send_receipt: args.send_receipt,
      };
      const result = await shopifyREST('/orders.json', {
        method: 'POST',
        body: JSON.stringify({ order }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_order: async (args) => {
    try {
      const order = {};
      if (args.email) order.email = args.email;
      if (args.note) order.note = args.note;
      if (args.tags) order.tags = args.tags;
      if (args.shipping_address) order.shipping_address = args.shipping_address;

      const result = await shopifyREST(`/orders/${args.order_id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ order }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  cancel_order: async (args) => {
    try {
      let url = `/orders/${args.order_id}/cancel.json`;
      const params = [];
      if (args.reason) params.push(`reason=${args.reason}`);
      if (args.refund !== undefined) params.push(`refund=${args.refund}`);
      if (args.restock !== undefined) params.push(`restock=${args.restock}`);
      if (args.email !== undefined) params.push(`email=${args.email}`);
      if (params.length) url += '?' + params.join('&');

      const result = await shopifyREST(url, { method: 'POST', body: '{}' });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  close_order: async (args) => {
    try {
      const result = await shopifyREST(`/orders/${args.order_id}/close.json`, {
        method: 'POST',
        body: '{}',
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  fulfill_order: async (args) => {
    try {
      const fulfillment = {
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_line_items: args.line_items || [],
          },
        ],
        tracking_info:
          args.tracking_company || args.tracking_number
            ? {
                number: args.tracking_number,
                company: args.tracking_company,
                url: args.tracking_url,
              }
            : undefined,
        notify_customer: args.notify_customer,
      };

      const result = await shopifyREST(
        `/orders/${args.order_id}/fulfillments.json`,
        {
          method: 'POST',
          body: JSON.stringify({ fulfillment }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  create_refund: async (args) => {
    try {
      const refund = {
        refund_line_items: args.refund_line_items,
        shipping: args.shipping,
        transactions: args.transactions,
        note: args.note,
        notify: args.notify,
      };
      const result = await shopifyREST(`/orders/${args.order_id}/refunds.json`, {
        method: 'POST',
        body: JSON.stringify({ refund }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  get_order_transactions: async (args) => {
    try {
      const data = await shopifyREST(
        `/orders/${args.order_id}/transactions.json`
      );
      return ok(data.transactions || []);
    } catch (error) {
      return err(error.message);
    }
  },

  list_draft_orders: async (args) => {
    try {
      let url = '/draft_orders.json?';
      const params = [];
      if (args.status) params.push(`status=${args.status}`);
      if (args.limit) params.push(`limit=${args.limit}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.draft_orders || []);
    } catch (error) {
      return err(error.message);
    }
  },

  create_draft_order: async (args) => {
    try {
      const draft_order = {
        line_items: args.line_items,
        customer: args.customer,
        shipping_address: args.shipping_address,
        discount: args.discount,
        note: args.note,
        tags: args.tags,
      };
      const result = await shopifyREST('/draft_orders.json', {
        method: 'POST',
        body: JSON.stringify({ draft_order }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  complete_draft_order: async (args) => {
    try {
      let url = `/draft_orders/${args.draft_order_id}/complete.json`;
      if (args.payment_gateway) url += `?payment_gateway=${args.payment_gateway}`;
      const result = await shopifyREST(url, {
        method: 'PUT',
        body: JSON.stringify({}),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  list_customers: async (args) => {
    try {
      let url = '/customers.json?';
      const params = [];
      if (args.limit) params.push(`limit=${args.limit}`);
      if (args.created_at_min) params.push(`created_at_min=${args.created_at_min}`);
      if (args.created_at_max) params.push(`created_at_max=${args.created_at_max}`);
      if (args.updated_at_min) params.push(`updated_at_min=${args.updated_at_min}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.customers || []);
    } catch (error) {
      return err(error.message);
    }
  },

  search_customers: async (args) => {
    try {
      const url = `/customers/search.json?query=${encodeURIComponent(args.query)}${args.limit ? `&limit=${args.limit}` : ''}`;
      const data = await shopifyREST(url);
      return ok(data.customers || []);
    } catch (error) {
      return err(error.message);
    }
  },

  get_customer: async (args) => {
    try {
      const data = await shopifyREST(`/customers/${args.customer_id}.json`);
      return ok(data.customer);
    } catch (error) {
      return err(error.message);
    }
  },

  create_customer: async (args) => {
    try {
      const customer = {
        email: args.email,
        first_name: args.first_name,
        last_name: args.last_name,
        phone: args.phone,
        note: args.note,
        tags: args.tags,
        accepts_marketing: args.accepts_marketing,
        verified_email: args.verified_email,
        addresses: args.addresses,
      };
      const result = await shopifyREST('/customers.json', {
        method: 'POST',
        body: JSON.stringify({ customer }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_customer: async (args) => {
    try {
      const customer = {};
      if (args.email) customer.email = args.email;
      if (args.first_name) customer.first_name = args.first_name;
      if (args.last_name) customer.last_name = args.last_name;
      if (args.phone) customer.phone = args.phone;
      if (args.note) customer.note = args.note;
      if (args.tags) customer.tags = args.tags;
      if (args.accepts_marketing !== undefined)
        customer.accepts_marketing = args.accepts_marketing;

      const result = await shopifyREST(`/customers/${args.customer_id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ customer }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  delete_customer: async (args) => {
    try {
      await shopifyREST(`/customers/${args.customer_id}.json`, {
        method: 'DELETE',
      });
      return ok({ message: 'Customer deleted' });
    } catch (error) {
      return err(error.message);
    }
  },

  get_customer_orders: async (args) => {
    try {
      let url = `/customers/${args.customer_id}/orders.json`;
      const params = [];
      if (args.limit) params.push(`limit=${args.limit}`);
      if (args.status) params.push(`status=${args.status}`);
      if (params.length) url += '?' + params.join('&');
      const data = await shopifyREST(url);
      return ok(data.orders || []);
    } catch (error) {
      return err(error.message);
    }
  },

  list_locations: async (args) => {
    try {
      const data = await shopifyREST('/locations.json');
      return ok(data.locations || []);
    } catch (error) {
      return err(error.message);
    }
  },

  get_inventory_levels: async (args) => {
    try {
      let url = '/inventory_levels.json?';
      const params = [];
      if (args.location_ids) params.push(`location_ids=${args.location_ids}`);
      if (args.inventory_item_ids)
        params.push(`inventory_item_ids=${args.inventory_item_ids}`);
      if (args.limit) params.push(`limit=${args.limit}`);
      url += params.join('&');
      const data = await shopifyREST(url);
      return ok(data.inventory_levels || []);
    } catch (error) {
      return err(error.message);
    }
  },

  adjust_inventory: async (args) => {
    try {
      const result = await shopifyREST(
        `/inventory_levels/adjust.json`,
        {
          method: 'POST',
          body: JSON.stringify({
            location_id: args.location_id,
            inventory_item_id: args.inventory_item_id,
            available_adjustment: args.available_adjustment,
          }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  set_inventory_level: async (args) => {
    try {
      const result = await shopifyREST(
        `/inventory_levels/set.json`,
        {
          method: 'POST',
          body: JSON.stringify({
            location_id: args.location_id,
            inventory_item_id: args.inventory_item_id,
            available: args.available,
            disconnect_if_necessary: true,
          }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  update_inventory_item: async (args) => {
    try {
      const updateBody = {};
      if (args.harmonized_system_code !== undefined)
        updateBody.harmonized_system_code = args.harmonized_system_code;
      if (args.country_code_of_origin !== undefined)
        updateBody.country_code_of_origin = args.country_code_of_origin;
      if (args.province_code_of_origin !== undefined)
        updateBody.province_code_of_origin = args.province_code_of_origin;
      if (args.tracked !== undefined) updateBody.tracked = args.tracked;
      if (args.cost !== undefined) updateBody.cost = args.cost;

      const result = await shopifyREST(
        `/inventory_items/${args.inventory_item_id}.json`,
        {
          method: 'PUT',
          body: JSON.stringify({ inventory_item: updateBody }),
        }
      );
      return { success: true, data: { id: result.inventory_item.id, hs_code: result.inventory_item.harmonized_system_code, country: result.inventory_item.country_code_of_origin } };
    } catch (error) {
      return err(error.message);
    }
  },

  list_price_rules: async (args) => {
    try {
      let url = '/price_rules.json';
      if (args.limit) url += `?limit=${args.limit}`;
      const data = await shopifyREST(url);
      return ok(data.price_rules || []);
    } catch (error) {
      return err(error.message);
    }
  },

  create_price_rule: async (args) => {
    try {
      const price_rule = {
        title: args.title,
        value_type: args.value_type,
        value: args.value,
        customer_selection: args.customer_selection,
        target_type: args.target_type,
        target_selection: args.target_selection,
        allocation_method: args.allocation_method,
        starts_at: args.starts_at,
        ends_at: args.ends_at,
        usage_limit: args.usage_limit,
        once_per_customer: args.once_per_customer,
        minimum_amount: args.minimum_amount,
      };
      const result = await shopifyREST('/price_rules.json', {
        method: 'POST',
        body: JSON.stringify({ price_rule }),
      });
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  create_discount_code: async (args) => {
    try {
      const discount_code = {
        price_rule_id: args.price_rule_id,
        code: args.code,
      };
      const result = await shopifyREST(
        `/price_rules/${args.price_rule_id}/discount_codes.json`,
        {
          method: 'POST',
          body: JSON.stringify({ discount_code }),
        }
      );
      return ok(result);
    } catch (error) {
      return err(error.message);
    }
  },

  list_discount_codes: async (args) => {
    try {
      const data = await shopifyREST(
        `/price_rules/${args.price_rule_id}/discount_codes.json`
      );
      return ok(data.discount_codes || []);
    } catch (error) {
      return err(error.message);
    }
  },

  delete_discount_code: async (args) => {
    try {
      await shopifyREST(
        `/price_rules/${args.price_rule_id}/discount_codes/${args.discount_code_id}.json`,
        { method: 'DELETE' }
      );
      return ok({ message: 'Discount code deleted' });
    } catch (error) {
      return err(error.message);
    }
  },

  list_metaobject_definitions: async (args) => {
    try {
      const query = `
        query {
          metaobjectDefinitions(first: ${args.limit || 10}) {
            edges {
              node {
                id
                name
                type
                description
                fieldDefinitions {
                  name
                  key
                  description
                  type {
                    name
                  }
                  required
                }
              }
            }
          }
        }
      `;
      const result = await shopifyGQL(query);
      return ok(
        result.metaobjectDefinitions.edges.map((e) => e.node) || []
      );
    } catch (error) {
      return err(error.message);
    }
  },

  create_metaobject_definition: async (args) => {
    try {
      const mutation = `
        mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
          metaobjectDefinitionCreate(definition: $definition) {
            metaobjectDefinition {
              id
              name
              type
              description
              fieldDefinitions {
                name
                key
                description
                type {
                  name
                }
                required
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const variables = {
        definition: {
          name: args.name,
          type: args.type,
          description: args.description,
          fieldDefinitions: args.fields,
        },
      };
      const result = await shopifyGQL(mutation, variables);
      if (result.metaobjectDefinitionCreate?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.metaobjectDefinitionCreate.userErrors)}`
        );
      }
      return ok(result.metaobjectDefinitionCreate.metaobjectDefinition);
    } catch (error) {
      return err(error.message);
    }
  },

  list_metaobjects: async (args) => {
    try {
      const query = `
        query MetaobjectsByType($type: String!) {
          metaobjects(type: $type, first: ${args.limit || 10}) {
            edges {
              node {
                id
                type
                handle
                fields {
                  key
                  value
                }
              }
            }
          }
        }
      `;
      const variables = { type: args.type };
      const result = await shopifyGQL(query, variables);
      return ok(result.metaobjects.edges.map((e) => e.node) || []);
    } catch (error) {
      return err(error.message);
    }
  },

  create_metaobject: async (args) => {
    try {
      const mutation = `
        mutation CreateMetaobject($input: MetaobjectInput!) {
          metaobjectCreate(input: $input) {
            metaobject {
              id
              type
              handle
              displayName
              fields {
                key
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const variables = {
        input: {
          type: args.type,
          fields: args.fields,
          handle: args.handle,
          capabilities: args.capabilities,
        },
      };
      const result = await shopifyGQL(mutation, variables);
      if (result.metaobjectCreate?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.metaobjectCreate.userErrors)}`
        );
      }
      return ok(result.metaobjectCreate.metaobject);
    } catch (error) {
      return err(error.message);
    }
  },

  update_metaobject: async (args) => {
    try {
      const mutation = `
        mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) {
            metaobject {
              id
              type
              handle
              displayName
              fields {
                key
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const variables = {
        id: args.id,
        metaobject: {
          fields: args.fields,
        },
      };
      const result = await shopifyGQL(mutation, variables);
      if (result.metaobjectUpdate?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.metaobjectUpdate.userErrors)}`
        );
      }
      return ok(result.metaobjectUpdate.metaobject);
    } catch (error) {
      return err(error.message);
    }
  },

  delete_metaobject: async (args) => {
    try {
      const mutation = `
        mutation DeleteMetaobject($id: ID!) {
          metaobjectDelete(id: $id) {
            deletedId
            userErrors {
              field
              message
            }
          }
        }
      `;
      const variables = { id: args.id };
      const result = await shopifyGQL(mutation, variables);
      if (result.metaobjectDelete?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.metaobjectDelete.userErrors)}`
        );
      }
      return ok({ deletedId: result.metaobjectDelete.deletedId });
    } catch (error) {
      return err(error.message);
    }
  },

  list_product_taxonomy: async (args) => {
    try {
      const query = `
        query {
          taxonomyCategories(first: 100) {
            edges {
              node {
                id
                name
                children(first: 50) {
                  edges {
                    node {
                      id
                      name
                      children(first: 50) {
                        edges {
                          node {
                            id
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const result = await shopifyGQL(query);
      return ok(result.taxonomyCategories.edges.map((e) => e.node) || []);
    } catch (error) {
      return err(error.message);
    }
  },

  list_publications: async (args) => {
    try {
      const query = `
        query {
          publications(first: 100) {
            edges {
              node {
                id
                name
                app {
                  title
                }
              }
            }
          }
        }
      `;
      const result = await shopifyGQL(query);
      return ok(result.publications.edges.map((e) => e.node) || []);
    } catch (error) {
      return err(error.message);
    }
  },

  publish_product_to_channel: async (args) => {
    try {
      const publicationIds = args.publication_ids
        .split(',')
        .map((id) => id.trim());
      const mutation = `
        mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable {
              ... on Product {
                id
                title
              }
              publicationCount
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const variables = {
        id: `gid://shopify/Product/${args.product_id}`,
        input: publicationIds.map((pubId) => ({
          publicationId: pubId.startsWith('gid://') ? pubId : `gid://shopify/Publication/${pubId}`,
        })),
      };
      const result = await shopifyGQL(mutation, variables);
      if (result.publishablePublish?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.publishablePublish.userErrors)}`
        );
      }
      return ok(result.publishablePublish.publishable);
    } catch (error) {
      return err(error.message);
    }
  },

  unpublish_product_from_channel: async (args) => {
    try {
      const mutation = `
        mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) {
            publishable {
              ... on Product {
                id
                title
              }
              publicationCount
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const pubId = args.publication_id.startsWith('gid://')
        ? args.publication_id
        : `gid://shopify/Publication/${args.publication_id}`;
      const variables = {
        id: `gid://shopify/Product/${args.product_id}`,
        input: [{ publicationId: pubId }],
      };
      const result = await shopifyGQL(mutation, variables);
      if (result.publishableUnpublish?.userErrors?.length) {
        throw new Error(
          `GraphQL errors: ${JSON.stringify(result.publishableUnpublish.userErrors)}`
        );
      }
      return ok(result.publishableUnpublish.publishable);
    } catch (error) {
      return err(error.message);
    }
  },

  get_shop_info: async (args) => {
    try {
      const query = `
        query {
          shop {
            name
            url
            currencyCode
            plan {
              displayName
              partnerDevelopment
            }
            email
            myshopifyDomain
            ianaTimezone
          }
        }
      `;
      const result = await shopifyGQL(query);
      return ok(result.shop);
    } catch (error) {
      return err(error.message);
    }
  },

  add_product_image_base64: async (args) => {
    try {
      const { product_id, base64_image, file_path, alt_text } = args;
      let { filename, mime_type } = args;

      // Resolve the image buffer from either file_path or base64_image
      let imageBuffer;
      if (file_path) {
        imageBuffer = readFileSync(file_path);
        if (!filename) filename = basename(file_path);
        if (!mime_type) {
          const ext = extname(file_path).toLowerCase();
          const mimeMap = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          };
          mime_type = mimeMap[ext] || 'image/png';
        }
      } else if (base64_image) {
        imageBuffer = Buffer.from(base64_image, 'base64');
      } else {
        throw new Error('Either file_path or base64_image must be provided');
      }
      filename = filename || 'image.png';
      mime_type = mime_type || 'image/png';

      // Step 1: Create a staged upload target
      const stagedMutation = `
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const stagedResult = await shopifyGQL(stagedMutation, {
        input: [
          {
            filename: filename || 'image.png',
            mimeType: mime_type || 'image/png',
            httpMethod: 'POST',
            resource: 'IMAGE',
          },
        ],
      });
      if (stagedResult.stagedUploadsCreate.userErrors?.length) {
        throw new Error(
          `Staged upload errors: ${JSON.stringify(stagedResult.stagedUploadsCreate.userErrors)}`
        );
      }

      const target = stagedResult.stagedUploadsCreate.stagedTargets[0];

      // Step 2: Upload the image to the staged URL via multipart form POST
      const boundary = '----FormBoundary' + Date.now().toString(36);
      const parts = [];

      // Add all parameters from the staged target
      for (const param of target.parameters) {
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${param.name}"\r\n\r\n${param.value}\r\n`
        );
      }

      // Add the file part
      const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'image.png'}"\r\nContent-Type: ${mime_type || 'image/png'}\r\n\r\n`;
      const fileFooter = `\r\n--${boundary}--\r\n`;

      const headerBuf = Buffer.from(fileHeader, 'utf-8');
      const footerBuf = Buffer.from(fileFooter, 'utf-8');
      const paramsBuf = Buffer.from(parts.join(''), 'utf-8');
      const body = Buffer.concat([paramsBuf, headerBuf, imageBuffer, footerBuf]);

      const uploadRes = await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length.toString(),
        },
        body,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Upload failed (${uploadRes.status}): ${errText}`);
      }

      // Step 3: Attach the uploaded image to the product
      let numericId = product_id;
      if (product_id.includes('/')) {
        const idParts = product_id.split('/');
        numericId = idParts[idParts.length - 1];
      }

      const mediaMutation = `
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media {
              ... on MediaImage {
                id
                image {
                  url
                  altText
                }
              }
            }
            mediaUserErrors {
              field
              message
            }
          }
        }
      `;
      const mediaResult = await shopifyGQL(mediaMutation, {
        productId: `gid://shopify/Product/${numericId}`,
        media: [
          {
            originalSource: target.resourceUrl,
            mediaContentType: 'IMAGE',
            alt: alt_text || '',
          },
        ],
      });
      if (mediaResult.productCreateMedia.mediaUserErrors?.length) {
        throw new Error(
          `Media errors: ${JSON.stringify(mediaResult.productCreateMedia.mediaUserErrors)}`
        );
      }
      // Return minimal confirmation — just the media ID
      const media = mediaResult.productCreateMedia.media?.[0];
      return { success: true, data: { mediaId: media?.id || null } };
    } catch (error) {
      return err(error.message);
    }
  },

  set_variant_metafield: async (args) => {
    try {
      // Build metafields array — supports single or batch mode
      let entries;
      if (args.metafields && Array.isArray(args.metafields)) {
        entries = args.metafields;
      } else if (args.variant_id && args.namespace && args.key && args.type && args.value) {
        entries = [{ variant_id: args.variant_id, namespace: args.namespace, key: args.key, type: args.type, value: args.value }];
      } else {
        throw new Error('Provide either (variant_id + namespace/key/type/value) or a metafields array');
      }

      if (entries.length > 25) {
        throw new Error(`Max 25 metafields per call (got ${entries.length})`);
      }

      const metafields = entries.map((e) => {
        const vid = e.variant_id.startsWith('gid://') ? e.variant_id : `gid://shopify/ProductVariant/${e.variant_id}`;
        return { ownerId: vid, namespace: e.namespace, key: e.key, type: e.type, value: e.value };
      });

      const mutation = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              key
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const result = await shopifyGQL(mutation, { metafields });
      const errors = result.metafieldsSet.userErrors || [];
      if (errors.length) {
        return { success: false, error: `Some metafields failed`, details: errors, set: result.metafieldsSet.metafields?.length || 0 };
      }
      return { success: true, data: { set: result.metafieldsSet.metafields.length, of: entries.length } };
    } catch (error) {
      return err(error.message);
    }
  },

  // ─── Themes ──────────────────────────────────────────────────────────────────

  list_themes: async (args) => {
    try {
      const data = await shopifyREST('/themes.json');
      return ok(
        (data.themes || []).map((t) => ({
          id: t.id,
          name: t.name,
          role: t.role,
          created_at: t.created_at,
          updated_at: t.updated_at,
        }))
      );
    } catch (error) {
      return err(error.message);
    }
  },

  get_theme: async (args) => {
    try {
      const data = await shopifyREST(`/themes/${args.theme_id}.json`);
      return ok(data.theme);
    } catch (error) {
      return err(error.message);
    }
  },

  create_theme: async (args) => {
    try {
      const body = { name: args.name };
      if (args.src) body.src = args.src;
      if (args.role) body.role = args.role;
      const data = await shopifyREST('/themes.json', {
        method: 'POST',
        body: JSON.stringify({ theme: body }),
      });
      return { success: true, data: { id: data.theme.id, name: data.theme.name, role: data.theme.role } };
    } catch (error) {
      return err(error.message);
    }
  },

  update_theme: async (args) => {
    try {
      const body = {};
      if (args.name) body.name = args.name;
      if (args.role) body.role = args.role;
      const data = await shopifyREST(`/themes/${args.theme_id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ theme: body }),
      });
      return { success: true, data: { id: data.theme.id, name: data.theme.name, role: data.theme.role } };
    } catch (error) {
      return err(error.message);
    }
  },

  delete_theme: async (args) => {
    try {
      await shopifyREST(`/themes/${args.theme_id}.json`, { method: 'DELETE' });
      return { success: true, data: { deleted: args.theme_id } };
    } catch (error) {
      return err(error.message);
    }
  },

  // ─── Theme Assets (Files) ────────────────────────────────────────────────────

  list_theme_assets: async (args) => {
    try {
      const data = await shopifyREST(`/themes/${args.theme_id}/assets.json`);
      return ok((data.assets || []).map((a) => a.key));
    } catch (error) {
      return err(error.message);
    }
  },

  get_theme_asset: async (args) => {
    try {
      const data = await shopifyREST(
        `/themes/${args.theme_id}/assets.json?asset[key]=${encodeURIComponent(args.key)}`
      );
      const asset = data.asset;
      // Return value (text content) or public_url (for binary assets)
      return ok({
        key: asset.key,
        content_type: asset.content_type,
        size: asset.size,
        value: asset.value || null,
        public_url: asset.public_url || null,
      });
    } catch (error) {
      return err(error.message);
    }
  },

  put_theme_asset: async (args) => {
    try {
      const asset = { key: args.key };
      if (args.value !== undefined) {
        asset.value = args.value;
      } else if (args.src) {
        asset.src = args.src;
      } else {
        throw new Error('Provide either "value" (file content) or "src" (URL)');
      }
      await shopifyREST(`/themes/${args.theme_id}/assets.json`, {
        method: 'PUT',
        body: JSON.stringify({ asset }),
      });
      return { success: true, data: { key: args.key } };
    } catch (error) {
      return err(error.message);
    }
  },

  delete_theme_asset: async (args) => {
    try {
      await shopifyREST(
        `/themes/${args.theme_id}/assets.json?asset[key]=${encodeURIComponent(args.key)}`,
        { method: 'DELETE' }
      );
      return { success: true, data: { deleted: args.key } };
    } catch (error) {
      return err(error.message);
    }
  },
};

// ─── Server Setup ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'Shopify MCP Server', version: '1.0.2' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  const handler = handlers[name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  }
  const result = await handler(toolArgs);
  return {
    isError: !result.success,
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Shopify MCP Server running — store:', SHOPIFY_STORE_DOMAIN);
