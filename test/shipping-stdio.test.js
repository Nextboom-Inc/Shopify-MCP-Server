import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { shippingTools } from '../src/shipping.js';

test('stdio MCP advertises shipping tools and dispatches reads without real Shopify access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipping-stdio-test-'));
  const preload = join(directory, 'mock-fetch.mjs');
  await writeFile(preload, `globalThis.fetch = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (!query.includes('query ShippingProfiles') || variables.first !== 2) throw new Error('Unexpected API request in MCP test');
    return new Response(JSON.stringify({ data: { deliveryProfiles: { nodes: [{ id: 'gid://shopify/DeliveryProfile/1', name: 'General', default: true }], pageInfo: { hasNextPage: false, endCursor: null } } } }), { status: 200 });
  };`);
  const client = new Client({ name: 'shipping-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', preload, fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { PATH: process.env.PATH, SHOPIFY_STORE_DOMAIN: 'mcp-test.invalid', SHOPIFY_ACCESS_TOKEN: 'test-only-token' }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    for (const tool of shippingTools) assert.deepEqual(catalog.tools.find(item => item.name === tool.name), tool);
    assert.ok(catalog.tools.some(item => item.name === 'get_shop_info'));
    const result = await client.callTool({ name: 'list_shipping_profiles', arguments: { limit: 2 } });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).data.nodes[0].name, 'General');
    const invalid = await client.callTool({ name: 'update_shipping_rate', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.match(JSON.parse(invalid.content[0].text).error, /required/);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
