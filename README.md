# Shopify MCP Server

A comprehensive [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the Shopify Admin API. Connect Claude (or any MCP client) to your Shopify store to manage products, orders, customers, inventory, metaobjects, discounts, and more.

## Features

- **Products** — list, create, update, delete, publish/unpublish, variants CRUD, images (URL and base64), metafields, category taxonomy
- **Collections** — custom & smart collections, add products, list collection products
- **Navigation menus** — list, get, create, update, and delete online store menus
- **Orders** — list, get, create, update, cancel, close, fulfill, refund, transactions
- **Draft Orders** — list, create, complete
- **Customers** — list, search, get, create, update, delete, customer order history
- **Inventory** — locations, get/adjust/set inventory levels
- **Metaobjects** — definitions (list/create) and entries (list/create/update/delete) via GraphQL
- **Metafields** — get/set on products and variants
- **Discounts** — price rules and discount codes (list, create, delete)
- **Publishing** — list sales channels, publish/unpublish products to channels
- **Themes** — list, create, update, delete themes; list, read, write, delete theme files (assets)

## Installation

### npx (recommended)

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "github:Nextboom-Inc/Shopify-MCP-Server"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your-app-client-id",
        "SHOPIFY_CLIENT_SECRET": "your-app-client-secret"
      }
    }
  }
}
```

### Clone & run locally

```bash
git clone https://github.com/Nextboom-Inc/Shopify-MCP-Server.git
cd Shopify-MCP-Server
npm install
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
SHOPIFY_CLIENT_ID=your-app-client-id \
SHOPIFY_CLIENT_SECRET=your-app-client-secret \
node src/index.js
```

## Configuration

| Environment Variable    | Description                              |
|------------------------|------------------------------------------|
| `SHOPIFY_STORE_DOMAIN` | Your store domain, e.g. `store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Optional static Shopify Admin API token (legacy fallback) |
| `SHOPIFY_CLIENT_ID`    | App client ID for token exchange         |
| `SHOPIFY_CLIENT_SECRET`| App client secret for token exchange     |

### Authentication

Preferred: provide `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. The server requests a fresh access token from:

- `POST https://{SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`
- Body: `grant_type=client_credentials`, `client_id`, `client_secret`

Fallback: if `SHOPIFY_ACCESS_TOKEN` is set, the server will use it directly.

### Getting app credentials and scopes

1. Go to the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
2. Create or select an app for the store
3. In the app's API access settings, grant the Admin API scopes you need
4. Install or reauthorize the app on the target Shopify store after changing scopes
5. Copy the app's client ID and client secret into your MCP server environment

### Admin API scopes

The MCP server can be run with only the scopes needed for the tools you plan to use. To enable every currently implemented tool, grant the app these Admin API scopes:

```text
read_products,write_products,
read_inventory,write_inventory,read_locations,
read_customers,write_customers,
read_orders,write_orders,read_all_orders,
read_draft_orders,write_draft_orders,
read_price_rules,write_price_rules,
read_discounts,write_discounts,
read_metaobjects,write_metaobjects,
read_metaobject_definitions,write_metaobject_definitions,
read_publications,write_publications,
read_themes,write_themes,
read_fulfillments,write_fulfillments,
read_online_store_navigation,write_online_store_navigation
```

Scope groups by tool area:

| Tool area | Scopes |
|-----------|--------|
| Shop info | No dedicated scope beyond Admin API access |
| Products, variants, product images, product metafields, product taxonomy | `read_products`, `write_products` |
| Variant metafields | `write_products` |
| Collections and collection membership | `read_products`, `write_products` |
| Navigation menus | `read_online_store_navigation`, `write_online_store_navigation` |
| Publications / sales channels | `read_publications`, `write_publications` |
| Orders, refunds, transactions, customer order history | `read_orders`, `write_orders`; add `read_all_orders` if you need access beyond Shopify's normal recent-order window |
| Fulfillments | `read_fulfillments`, `write_fulfillments` |
| Draft orders | `read_draft_orders`, `write_draft_orders` |
| Customers | `read_customers`, `write_customers` |
| Inventory levels and inventory items | `read_inventory`, `write_inventory` |
| Locations | `read_locations` |
| Price rules | `read_price_rules`, `write_price_rules` |
| Discount codes | `read_discounts`, `write_discounts` |
| Metaobject entries | `read_metaobjects`, `write_metaobjects` |
| Metaobject definitions | `read_metaobject_definitions`, `write_metaobject_definitions` |
| Themes and theme assets | `read_themes`, `write_themes` |

The server does not currently implement Shopify content/page/blog tools, so `read_content` and `write_content` are not required for the current tool set.

## Available Tools (76)

### Shop
| Tool | Description |
|------|-------------|
| `get_shop_info` | Get store name, domain, currency, plan info |

### Products
| Tool | Description |
|------|-------------|
| `list_products` | List products with filters (status, vendor, type, collection) |
| `get_product` | Get a product by ID with all variants and images |
| `create_product` | Create a product with variants, options, images, and metafields |
| `update_product` | Update title, description, vendor, status, tags |
| `delete_product` | Permanently delete a product |
| `publish_product` | Publish or unpublish a product |
| `set_product_category` | Set product category using Shopify standard taxonomy (GraphQL) |
| `list_product_taxonomy` | List all product categories in the Shopify taxonomy |
| `list_product_variants` | List all variants for a product |
| `create_product_variant` | Add a new variant (price, SKU, options, inventory) |
| `update_product_variant` | Update a variant's price, SKU, weight, options |
| `delete_product_variant` | Remove a variant from a product |
| `get_product_metafields` | Get metafields on a product |
| `set_product_metafield` | Create or update a metafield on a product |
| `add_product_image` | Add an image to a product by URL |
| `add_product_image_base64` | Upload a base64-encoded image and attach it to a product (uses staged uploads) |

### Variant Metafields
| Tool | Description |
|------|-------------|
| `set_variant_metafield` | Set or update a metafield on a specific product variant |

### Publishing / Sales Channels
| Tool | Description |
|------|-------------|
| `list_publications` | List all sales channels / publications the store has enabled |
| `publish_product_to_channel` | Publish a product to one or more sales channels |
| `unpublish_product_from_channel` | Remove a product from a specific sales channel |

### Collections
| Tool | Description |
|------|-------------|
| `list_collections` | List all custom and smart collections |
| `get_collection` | Get a collection by ID |
| `create_collection` | Create a new custom collection |
| `update_collection` | Update collection title, description, sort order |
| `add_product_to_collection` | Add a product to a custom collection |
| `list_collection_products` | List products in a collection |

### Navigation Menus
| Tool | Description |
|------|-------------|
| `list_menus` | List online store navigation menus |
| `get_menu` | Get a navigation menu by ID |
| `create_menu` | Create an online store navigation menu |
| `update_menu` | Update an online store navigation menu |
| `delete_menu` | Delete an online store navigation menu |

### Orders
| Tool | Description |
|------|-------------|
| `list_orders` | List orders with status/financial/fulfillment filters |
| `get_order` | Get full order details |
| `create_order` | Create an order programmatically |
| `update_order` | Update order note, tags, email, shipping address |
| `cancel_order` | Cancel with reason, optional restock and refund |
| `close_order` | Mark order as closed |
| `fulfill_order` | Create a fulfillment with tracking info |
| `create_refund` | Refund line items or shipping |
| `get_order_transactions` | Get all payment transactions |

### Draft Orders
| Tool | Description |
|------|-------------|
| `list_draft_orders` | List draft orders |
| `create_draft_order` | Create a draft order with custom discounts |
| `complete_draft_order` | Convert draft to a live order |

### Customers
| Tool | Description |
|------|-------------|
| `list_customers` | List all customers |
| `search_customers` | Search by name, email, or phone |
| `get_customer` | Get customer by ID |
| `create_customer` | Create a new customer with addresses |
| `update_customer` | Update customer details |
| `delete_customer` | Delete a customer |
| `get_customer_orders` | Get order history for a customer |

### Inventory
| Tool | Description |
|------|-------------|
| `list_locations` | List all fulfillment locations |
| `get_inventory_levels` | Get inventory by location or item |
| `adjust_inventory` | Relative adjustment (+/-) to inventory |
| `set_inventory_level` | Set absolute inventory quantity |

### Discounts
| Tool | Description |
|------|-------------|
| `list_price_rules` | List all price rules |
| `create_price_rule` | Create a price rule (fixed amount or percentage) |
| `create_discount_code` | Create a discount code for a price rule |
| `list_discount_codes` | List codes for a price rule |
| `delete_discount_code` | Delete a discount code |

### Metaobjects (GraphQL)
| Tool | Description |
|------|-------------|
| `list_metaobject_definitions` | List all metaobject definitions (content types) |
| `create_metaobject_definition` | Create a new metaobject definition with fields |
| `list_metaobjects` | List metaobject entries by type |
| `create_metaobject` | Create a new metaobject entry |
| `update_metaobject` | Update metaobject fields |
| `delete_metaobject` | Delete a metaobject entry |

### Themes
| Tool | Description |
|------|-------------|
| `list_themes` | List all themes in the store |
| `get_theme` | Get a theme by ID |
| `create_theme` | Create a new theme (from a ZIP URL or blank) |
| `update_theme` | Update a theme (name or role/publish) |
| `delete_theme` | Delete a theme |

### Theme Assets (Files)
| Tool | Description |
|------|-------------|
| `list_theme_assets` | List all file paths in a theme |
| `get_theme_asset` | Read a theme file by key (e.g. `templates/index.json`) |
| `put_theme_asset` | Create or update a theme file (text content or URL source) |
| `delete_theme_asset` | Delete a theme file |

## Requirements

- Node.js 18+
- Shopify store with Admin API access

## A note on Shopify's REST API

Shopify marked the REST Admin API as **legacy as of October 1, 2024**, with new public apps required to use GraphQL exclusively from April 2025 onward. This server uses the latest stable REST API version (`2026-01`) for broad compatibility with private/custom apps and is fully functional. The metaobjects, product taxonomy, publishing, and image upload features already use GraphQL. Future versions of this server may migrate remaining endpoints to GraphQL.

## License

MIT
