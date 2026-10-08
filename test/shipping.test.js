import test from 'node:test';
import assert from 'node:assert/strict';
import { createShippingHandlers } from '../src/shipping.js';

const gid = (type, id) => `gid://shopify/${type}/${id}`;
const profileId = gid('DeliveryProfile', 1);
const groupId = gid('DeliveryLocationGroup', 2);
const zoneId = gid('DeliveryZone', 3);
const methodId = gid('DeliveryMethodDefinition', 4);
const conditionId = gid('DeliveryCondition', 5);
const money = amount => ({ amount, currencyCode: 'USD' });
const method = () => ({ id: methodId, name: 'Standard', description: '3–5 days', active: true,
  rateProvider: { __typename: 'DeliveryRateDefinition', id: gid('DeliveryRateDefinition', 6), price: money('5.95') },
  methodConditions: [{ id: conditionId, field: 'TOTAL_PRICE', operator: 'LESS_THAN_OR_EQUAL_TO', conditionCriteria: { __typename: 'MoneyV2', ...money('49.99') } }],
});
const zone = () => ({ id: zoneId, name: 'Domestic', countries: [{ name: 'United States', code: { countryCode: 'US', restOfWorld: false }, provinces: [{ id: gid('DeliveryProvince', 7), name: 'Colorado', code: 'CO' }] }] });
const pageInfo = (hasNextPage = false, endCursor = null) => ({ hasNextPage, endCursor });
function fixture() {
  const state = { methods: [method()], mutations: [], calls: [] };
  const gql = async (query, variables) => {
    state.calls.push({ query, variables });
    if (query.includes('query ShippingProfiles')) return { deliveryProfiles: { nodes: [{ id: profileId, name: 'General', default: true }], pageInfo: pageInfo() } };
    if (query.includes('query ShippingProfile(')) return { deliveryProfile: { id: profileId, name: 'General', default: true, profileLocationGroups: [{ locationGroup: { id: groupId } }] } };
    if (query.includes('query ShippingLocations')) return { deliveryProfile: { profileLocationGroups: [{ locationGroup: { id: groupId, locations: { nodes: [{ id: gid('Location', 8), name: 'Warehouse' }], pageInfo: pageInfo() } } }] } };
    if (query.includes('query ShippingZones')) return { deliveryProfile: { profileLocationGroups: [{ locationGroup: { id: groupId }, locationGroupZones: {
      edges: [{ cursor: 'zone-1', node: { zone: zone(), methodDefinitions: { nodes: structuredClone(state.methods), pageInfo: pageInfo() } } }], pageInfo: pageInfo(),
    } }] } };
    if (query.includes('mutation UpdateShippingRate')) {
      state.mutations.push(variables);
      const update = variables.profile.locationGroupsToUpdate[0].zonesToUpdate[0];
      const input = update.methodDefinitionsToUpdate?.[0] || update.methodDefinitionsToCreate[0];
      const target = update.methodDefinitionsToUpdate ? state.methods.find(item => item.id === input.id) : { ...method(), id: gid('DeliveryMethodDefinition', 9), methodConditions: [] };
      if (!update.methodDefinitionsToUpdate) state.methods.push(target);
      for (const key of ['name', 'description', 'active']) if (Object.hasOwn(input, key)) target[key] = input[key];
      if (input.rateDefinition) target.rateProvider.price = input.rateDefinition.price;
      for (const condition of input.conditionsToUpdate || []) {
        const saved = target.methodConditions.find(item => item.id === condition.id);
        saved.operator = condition.operator;
        saved.conditionCriteria = { __typename: 'MoneyV2', amount: String(condition.criteria), currencyCode: condition.criteriaUnit };
      }
      for (const condition of input.priceConditionsToCreate || []) target.methodConditions.push({ id: gid('DeliveryCondition', 10), field: 'TOTAL_PRICE', operator: condition.operator, conditionCriteria: { __typename: 'MoneyV2', ...condition.criteria } });
      return { deliveryProfileUpdate: { profile: { id: profileId, name: 'General' }, userErrors: [] } };
    }
    throw new Error('Unexpected query');
  };
  return { state, gql, handlers: createShippingHandlers(gql) };
}
async function target(handlers) {
  const snapshot = await handlers.get_shipping_profile({ profile_id: profileId });
  assert.equal(snapshot.success, true);
  return { profile_id: profileId, location_group_id: groupId, zone_id: zoneId, expected_zone_fingerprint: snapshot.data.profileLocationGroups[0].zones[0].fingerprint };
}

test('profile listing returns page cursors and supports app-managed profiles', async () => {
  const { handlers, state } = fixture();
  const result = await handlers.list_shipping_profiles({ limit: 2, after: 'profile-cursor' });
  assert.equal(result.success, true);
  assert.deepEqual(state.calls[0].variables, { first: 2, after: 'profile-cursor', merchantOwnedOnly: false });
  assert.deepEqual(result.data.pageInfo, pageInfo());
});

test('complete profile includes locations, destination regions, prices and condition IDs', async () => {
  const { handlers } = fixture();
  const result = await handlers.get_shipping_profile({ profile_id: profileId });
  const group = result.data.profileLocationGroups[0];
  assert.equal(group.locationGroup.locations[0].name, 'Warehouse');
  assert.deepEqual(group.zones[0].methodDefinitions, [method()]);
  assert.match(group.zones[0].fingerprint, /^[a-f0-9]{64}$/);
});

test('invalid input is rejected before any Shopify request', async () => {
  const { handlers, state } = fixture();
  for (const args of [{ limit: 0 }, { limit: 1.1 }, { limit: 251 }, { limit: NaN }, { unsupported: true }]) assert.equal((await handlers.list_shipping_profiles(args)).success, false);
  for (const args of [{ profile_id: '1' }, { profile_id: gid('Product', 1) }, {}]) assert.equal((await handlers.get_shipping_profile(args)).success, false);
  assert.equal(state.calls.length, 0);
});

test('price-only update preserves all other rate fields and uses the scoped partial update', async () => {
  const { handlers, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId, price: money('6.95') };
  const result = await handlers.update_shipping_rate(args);
  assert.equal(result.success, true);
  assert.equal(result.data.method.rateProvider.price.amount, '6.95');
  assert.deepEqual(state.mutations[0], { id: profileId, profile: { locationGroupsToUpdate: [{ id: groupId, zonesToUpdate: [{ id: zoneId, methodDefinitionsToUpdate: [{ id: methodId, rateDefinition: { id: gid('DeliveryRateDefinition', 6), price: money('6.95') } }] }] }] } });
  assert.deepEqual(result.data.method.methodConditions, method().methodConditions);
  assert.equal(result.data.method.name, 'Standard');
});

test('stale snapshots prevent writes', async () => {
  const { handlers, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId, price: money('6.95') };
  state.methods[0].description = 'Changed elsewhere';
  const result = await handlers.update_shipping_rate(args);
  assert.match(result.error, /changed since the snapshot/);
  assert.equal(state.mutations.length, 0);
});

test('writes reject foreign zones, methods, and calculated rates', async () => {
  const { handlers, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId, price: money('6.95') };
  assert.match((await handlers.update_shipping_rate({ ...args, zone_id: gid('DeliveryZone', 999) })).error, /does not belong/);
  assert.match((await handlers.update_shipping_rate({ ...args, method_id: gid('DeliveryMethodDefinition', 999) })).error, /does not belong/);
  state.methods[0].rateProvider = { __typename: 'DeliveryParticipant', id: gid('DeliveryParticipant', 6) };
  assert.match((await handlers.update_shipping_rate({ ...await target(handlers), method_id: methodId, price: money('6.95') })).error, /Calculated/);
  assert.equal(state.mutations.length, 0);
});

test('invalid money, currencies and no-op updates do not mutate', async () => {
  const { handlers, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId };
  for (const price of [money('-1'), money('NaN'), money('1e2'), { amount: '5', currencyCode: 'usd' }, { amount: 5, currencyCode: 'USD' }, { ...money('5'), unexpected: true }]) assert.equal((await handlers.update_shipping_rate({ ...args, price })).success, false);
  assert.equal((await handlers.update_shipping_rate(args)).success, false);
  assert.match((await handlers.update_shipping_rate({ ...args, price: { amount: '5', currencyCode: 'EUR' } })).error, /currency/);
  assert.equal(state.mutations.length, 0);
});

test('updates one selected existing price condition and rejects foreign conditions', async () => {
  const { handlers, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId, conditions_to_update: [{ id: conditionId, operator: 'LESS_THAN_OR_EQUAL_TO', criteria: 39.99, criteriaUnit: 'USD' }] };
  const result = await handlers.update_shipping_rate(args);
  assert.equal(result.success, true);
  assert.equal(result.data.method.methodConditions[0].conditionCriteria.amount, '39.99');
  const next = { ...args, ...await target(handlers), conditions_to_update: [{ ...args.conditions_to_update[0], id: gid('DeliveryCondition', 999) }] };
  assert.match((await handlers.update_shipping_rate(next)).error, /Only existing price conditions/);
  assert.equal(state.mutations.length, 1);
});

test('create adds a fixed rate with a price condition and returns its saved ID', async () => {
  const { handlers, state } = fixture();
  const result = await handlers.create_shipping_rate({ ...await target(handlers), name: 'Free Standard', price: money('0'), active: true,
    price_conditions_to_create: [{ operator: 'GREATER_THAN_OR_EQUAL_TO', criteria: money('50') }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data.method.id, gid('DeliveryMethodDefinition', 9));
  assert.deepEqual(state.methods[0], method());
});

test('Shopify user errors and access denials are reported', async () => {
  const denied = createShippingHandlers(async () => { throw new Error('Access denied for deliveryProfiles: read_shipping required'); });
  assert.match((await denied.list_shipping_profiles()).error, /read_shipping/);
  const { gql, handlers } = fixture();
  const args = { ...await target(handlers), method_id: methodId, price: money('7') };
  const rejected = createShippingHandlers(async (query, vars) => query.includes('mutation') ? { deliveryProfileUpdate: { userErrors: [{ field: ['profile'], message: 'Rejected' }], profile: null } } : gql(query, vars));
  const result = await rejected.update_shipping_rate(args);
  assert.equal(result.success, false);
  assert.match(result.error, /Rejected/);
});

test('shipping permission failures report the app grants through a read-only query', async () => {
  const denied = createShippingHandlers(async query => {
    if (query.includes('query ShippingAccess')) return { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } };
    throw new Error('ACCESS_DENIED for deliveryProfiles');
  });
  const result = await denied.list_shipping_profiles();
  assert.equal(result.success, false);
  assert.deepEqual(result.granted_shipping_scopes, []);
  assert.deepEqual(result.required_shipping_scopes, ['read_shipping']);
});

test('accepted writes with failed readback report mutation_applied to prevent blind create retries', async () => {
  const { gql, handlers } = fixture();
  const args = { ...await target(handlers), name: 'Expedited', price: money('9.95') };
  let written = false;
  const failing = createShippingHandlers(async (query, vars) => {
    if (written) throw new Error('Readback unavailable');
    const result = await gql(query, vars);
    if (query.includes('mutation')) written = true;
    return result;
  });
  const result = await failing.create_shipping_rate(args);
  assert.equal(result.success, false);
  assert.equal(result.mutation_applied, true);
  assert.match(result.error, /before retrying/);
});

test('incorrect persisted price fails verification even after an accepted mutation', async () => {
  const { handlers, gql, state } = fixture();
  const args = { ...await target(handlers), method_id: methodId, price: money('7') };
  const failing = createShippingHandlers(async (query, vars) => {
    const result = await gql(query, vars);
    if (query.includes('mutation')) state.methods[0].rateProvider.price = money('99');
    return result;
  });
  const result = await failing.update_shipping_rate(args);
  assert.equal(result.mutation_applied, true);
  assert.match(result.error, /does not match/);
});

test('nested pagination covers more than one location, zone and method page', async () => {
  const { gql } = fixture();
  const calls = [];
  const paginated = createShippingHandlers(async (query, vars) => {
    calls.push(vars);
    const result = await gql(query, vars);
    if (query.includes('ShippingLocations')) {
      const connection = result.deliveryProfile.profileLocationGroups[0].locationGroup.locations;
      connection.nodes[0].id = gid('Location', vars.after ? 9 : 8);
      connection.pageInfo = pageInfo(!vars.after, vars.after ? null : 'location-next');
    }
    if (query.includes('ShippingZones')) {
      const connection = result.deliveryProfile.profileLocationGroups[0].locationGroupZones;
      const node = connection.edges[0].node;
      if (vars.methodsAfter) {
        node.methodDefinitions.nodes[0].id = gid('DeliveryMethodDefinition', 11);
      } else if (!vars.after) {
        node.methodDefinitions.pageInfo = pageInfo(true, 'method-next');
        connection.pageInfo = pageInfo(true, 'zone-next');
      } else {
        node.zone.id = gid('DeliveryZone', 12);
        node.methodDefinitions.nodes = [];
      }
    }
    return result;
  });
  const result = await paginated.get_shipping_profile({ profile_id: profileId });
  assert.equal(result.success, true);
  const group = result.data.profileLocationGroups[0];
  assert.equal(group.locationGroup.locations.length, 2);
  assert.equal(group.zones.length, 2);
  assert.equal(group.zones[0].methodDefinitions.length, 2);
  assert.ok(calls.some(vars => vars.methodsAfter === 'method-next' && vars.first === 1 && vars.after === null));
});

test('non-advancing pagination fails instead of returning a partial profile', async () => {
  const { gql } = fixture();
  const broken = createShippingHandlers(async (query, vars) => {
    const result = await gql(query, vars);
    if (query.includes('ShippingLocations')) result.deliveryProfile.profileLocationGroups[0].locationGroup.locations.pageInfo = pageInfo(true, 'repeated');
    return result;
  });
  assert.match((await broken.get_shipping_profile({ profile_id: profileId })).error, /did not advance/);
});

test('transport failure during a mutation reports an unknown outcome', async () => {
  const { gql, handlers } = fixture();
  const args = { ...await target(handlers), name: 'Expedited', price: money('9.95') };
  const failing = createShippingHandlers(async (query, vars) => {
    if (query.includes('mutation')) throw new Error('Connection lost');
    return gql(query, vars);
  });
  const result = await failing.create_shipping_rate(args);
  assert.equal(result.mutation_status, 'unknown');
  assert.match(result.error, /before retrying/);
});

test('readback detects changes to omitted fields and unrelated settings', async () => {
  for (const alter of [state => { state.methods[0].description = 'Unexpected'; }, state => { state.methods.push({ ...method(), id: gid('DeliveryMethodDefinition', 15) }); }]) {
    const { handlers, gql, state } = fixture();
    const args = { ...await target(handlers), method_id: methodId, price: money('7') };
    const failing = createShippingHandlers(async (query, vars) => {
      const result = await gql(query, vars);
      if (query.includes('mutation')) alter(state);
      return result;
    });
    const result = await failing.update_shipping_rate(args);
    assert.equal(result.success, false);
    assert.equal(result.mutation_applied, true);
  }
});
