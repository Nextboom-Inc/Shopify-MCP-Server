import { createHash } from 'node:crypto';

const PAGE_SIZE = 10;
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const MONEY = { type: 'object', additionalProperties: false, properties: {
  amount: { type: 'string', pattern: '^\\d+(\\.\\d+)?$', maxLength: 64 },
  currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
}, required: ['amount', 'currencyCode'] };
const OPERATORS = ['GREATER_THAN_OR_EQUAL_TO', 'LESS_THAN_OR_EQUAL_TO'];
const PRICE_CONDITION = { type: 'object', additionalProperties: false, properties: {
  operator: { type: 'string', enum: OPERATORS }, criteria: MONEY,
}, required: ['operator', 'criteria'] };
const CONDITION_UPDATE = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string' }, operator: { type: 'string', enum: OPERATORS },
  criteria: { type: 'number', minimum: 0 }, criteriaUnit: { type: 'string', pattern: '^[A-Z]{3}$' },
}, required: ['id', 'operator', 'criteria', 'criteriaUnit'] };
const RATE_PROPERTIES = {
  name: { type: 'string', minLength: 1 }, description: { type: 'string' }, active: { type: 'boolean' },
  price: MONEY,
  price_conditions_to_create: { type: 'array', maxItems: 2, items: PRICE_CONDITION },
};
const TARGET_PROPERTIES = {
  profile_id: { type: 'string' }, location_group_id: { type: 'string' }, zone_id: { type: 'string' },
  expected_zone_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Fingerprint from a fresh get_shipping_profile result. Back up that result before writing.' },
};
export const shippingTools = [
  { name: 'list_shipping_profiles', description: 'List shipping profile summaries with cursor pagination. Requires read_shipping.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 250 }, after: { type: 'string' },
      merchant_owned_only: { type: 'boolean' },
    } } },
  { name: 'get_shipping_profile', description: 'Read a complete shipping profile, including all locations, zones, fixed and calculated rates, conditions, and zone fingerprints. Follows nested pagination. Requires read_shipping.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { profile_id: { type: 'string' } }, required: ['profile_id'] } },
  { name: 'create_shipping_rate', description: 'Add one fixed shipping rate to an existing zone. Requires a fresh zone fingerprint and write_shipping. Does not change zones, products, locations, or existing rates. Read and back up the profile first.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...TARGET_PROPERTIES, ...RATE_PROPERTIES }, required: [...Object.keys(TARGET_PROPERTIES), 'name', 'price'] } },
  { name: 'update_shipping_rate', description: 'Update one existing fixed shipping rate and selected price conditions. Requires a fresh zone fingerprint and write_shipping. Preserves omitted fields. Does not replace calculated rates or remove conditions. Read and back up the profile first.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      ...TARGET_PROPERTIES, ...RATE_PROPERTIES, method_id: { type: 'string' },
      conditions_to_update: { type: 'array', maxItems: 2, items: CONDITION_UPDATE },
    }, required: [...Object.keys(TARGET_PROPERTIES), 'method_id'] } },
];

const METHOD_FIELDS = `id name description active
  rateProvider { __typename
    ... on DeliveryRateDefinition { id price { amount currencyCode } }
    ... on DeliveryParticipant { id fixedFee { amount currencyCode } percentageOfRateFee
      adaptToNewServicesFlag participantServices { name active } }
  }
  methodConditions { id field operator conditionCriteria { __typename
    ... on MoneyV2 { amount currencyCode } ... on Weight { value unit } } }`;
export const shippingQueries = {
  access: `query ShippingAccess { currentAppInstallation { accessScopes { handle } } }`,
  list: `query ShippingProfiles($first: Int!, $after: String, $merchantOwnedOnly: Boolean) {
    deliveryProfiles(first: $first, after: $after, merchantOwnedOnly: $merchantOwnedOnly) {
      nodes { id name default } ${PAGE_INFO}
    }
  }`,
  profile: `query ShippingProfile($id: ID!) {
    deliveryProfile(id: $id) { id name default profileLocationGroups { locationGroup { id } } }
  }`,
  locations: `query ShippingLocations($id: ID!, $group: ID!, $after: String) {
    deliveryProfile(id: $id) { profileLocationGroups(locationGroupId: $group) {
      locationGroup { id locations(first: 50, after: $after) { nodes { id name } ${PAGE_INFO} } }
    } }
  }`,
  zones: `query ShippingZones($id: ID!, $group: ID!, $first: Int!, $after: String, $methodsAfter: String) {
    deliveryProfile(id: $id) { profileLocationGroups(locationGroupId: $group) {
      locationGroup { id }
      locationGroupZones(first: $first, after: $after) {
        edges { cursor node {
          zone { id name countries { name code { countryCode restOfWorld } provinces { id name code } } }
          methodDefinitions(first: ${PAGE_SIZE}, after: $methodsAfter) { nodes { ${METHOD_FIELDS} } ${PAGE_INFO} }
        } } ${PAGE_INFO}
      }
    } }
  }`,
  update: `mutation UpdateShippingRate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name } userErrors { field message }
    }
  }`,
};

// The MCP SDK does not validate tool arguments against JSON Schema here.
function validate(value, schema, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unsupported ${path}.${key}`);
      validate(value[key], schema.properties[key], `${path}.${key}`);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new Error(`Invalid ${path} array`);
    value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  } else {
    const numeric = schema.type === 'integer' || schema.type === 'number';
    if (typeof value !== (numeric ? 'number' : schema.type)) throw new Error(`Invalid ${path} type`);
    if (numeric && (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`Invalid ${path} value`);
    if (schema.type === 'string' && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new Error(`Invalid ${path} value`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path} value`);
  }
}
function gid(value, type) {
  if (typeof value !== 'string' || !new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(value)) throw new Error(`Expected a ${type} GID`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function nextCursor(connection, seen) {
  if (!connection?.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') throw new Error('Missing shipping pagination metadata');
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) throw new Error('Shipping pagination did not advance');
  seen.add(cursor);
  return cursor;
}
function groupFrom(result, groupId) {
  const group = result.deliveryProfile?.profileLocationGroups.find(item => item.locationGroup.id === groupId);
  if (!group) throw new Error('Shipping location group was not found');
  return group;
}
function amountEqual(left, right) {
  const normalize = value => { const [whole, fraction = ''] = String(value).split('.'); return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`; };
  return normalize(left) === normalize(right);
}

export function createShippingHandlers(shopifyGQL) {
  async function readProfile(profileId) {
    gid(profileId, 'DeliveryProfile');
    const initial = await shopifyGQL(shippingQueries.profile, { id: profileId });
    if (!initial.deliveryProfile) throw new Error('Shipping profile was not found');
    const profile = initial.deliveryProfile;
    for (const group of profile.profileLocationGroups) {
      const groupId = group.locationGroup.id;
      group.locationGroup.locations = [];
      let after = null;
      const locationCursors = new Set();
      do {
        const result = await shopifyGQL(shippingQueries.locations, { id: profileId, group: groupId, after });
        const connection = groupFrom(result, groupId).locationGroup.locations;
        group.locationGroup.locations.push(...connection.nodes);
        after = nextCursor(connection, locationCursors);
      } while (after);
      group.zones = [];
      after = null;
      const zoneCursors = new Set();
      do {
        const result = await shopifyGQL(shippingQueries.zones, { id: profileId, group: groupId, first: PAGE_SIZE, after, methodsAfter: null });
        const connection = groupFrom(result, groupId).locationGroupZones;
        let precedingCursor = after;
        for (const edge of connection.edges) {
          const entry = { zone: edge.node.zone, methodDefinitions: [...edge.node.methodDefinitions.nodes] };
          const methodCursors = new Set();
          let methodsAfter = nextCursor(edge.node.methodDefinitions, methodCursors);
          while (methodsAfter) {
            const page = await shopifyGQL(shippingQueries.zones, { id: profileId, group: groupId, first: 1, after: precedingCursor, methodsAfter });
            const target = groupFrom(page, groupId).locationGroupZones.edges[0]?.node;
            if (target?.zone.id !== entry.zone.id) throw new Error('Shipping zones changed during pagination; read again');
            entry.methodDefinitions.push(...target.methodDefinitions.nodes);
            methodsAfter = nextCursor(target.methodDefinitions, methodCursors);
          }
          entry.fingerprint = fingerprint({ profileId, groupId, ...entry });
          group.zones.push(entry);
          precedingCursor = edge.cursor;
        }
        after = nextCursor(connection, zoneCursors);
      } while (after);
    }
    return profile;
  }
  function targetZone(profile, args) {
    const group = profile.profileLocationGroups.find(item => item.locationGroup.id === args.location_group_id);
    const entry = group?.zones.find(item => item.zone.id === args.zone_id);
    if (!entry) throw new Error('Shipping zone does not belong to the specified profile and location group');
    return entry;
  }
  async function writeRate(args, create) {
    gid(args.profile_id, 'DeliveryProfile');
    gid(args.location_group_id, 'DeliveryLocationGroup');
    gid(args.zone_id, 'DeliveryZone');
    if (!create) gid(args.method_id, 'DeliveryMethodDefinition');
    const keys = Object.keys(RATE_PROPERTIES).concat('conditions_to_update');
    if (!create && !keys.some(key => Object.hasOwn(args, key) && (!Array.isArray(args[key]) || args[key].length))) throw new Error('At least one rate field must change');
    const before = await readProfile(args.profile_id);
    const entry = targetZone(before, args);
    if (entry.fingerprint !== args.expected_zone_fingerprint) throw new Error('Shipping zone changed since the snapshot; read and back up the profile again');
    const current = create ? null : entry.methodDefinitions.find(method => method.id === args.method_id);
    if (!create && !current) throw new Error('Shipping method does not belong to the specified zone');
    if (current && current.rateProvider.__typename !== 'DeliveryRateDefinition') throw new Error('Calculated shipping rates cannot be changed with this tool');
    const method = create ? {} : { id: current.id };
    for (const key of ['name', 'description', 'active']) if (Object.hasOwn(args, key)) method[key] = args[key];
    if (args.price) method.rateDefinition = { ...(current ? { id: current.rateProvider.id } : {}), price: args.price };
    if (args.price_conditions_to_create) method.priceConditionsToCreate = args.price_conditions_to_create;
    if (args.conditions_to_update) {
      for (const update of args.conditions_to_update) {
        gid(update.id, 'DeliveryCondition');
        const condition = current.methodConditions.find(item => item.id === update.id);
        if (!condition || condition.field !== 'TOTAL_PRICE' || condition.conditionCriteria.__typename !== 'MoneyV2') throw new Error('Only existing price conditions on the selected rate can be updated');
      }
      if (new Set(args.conditions_to_update.map(item => item.id)).size !== args.conditions_to_update.length) throw new Error('Duplicate condition IDs');
      method.conditionsToUpdate = args.conditions_to_update.map(item => ({ ...item, field: 'TOTAL_PRICE' }));
    }
    const currency = args.price?.currencyCode || current?.rateProvider.price.currencyCode;
    if (current && args.price && currency !== current.rateProvider.price.currencyCode) throw new Error('Changing a rate currency is not supported');
    if ((args.price_conditions_to_create || []).some(item => item.criteria.currencyCode !== currency) || (args.conditions_to_update || []).some(item => item.criteriaUnit !== currency)) throw new Error('Price conditions must use the rate currency');
    const profile = { locationGroupsToUpdate: [{ id: args.location_group_id, zonesToUpdate: [{ id: args.zone_id,
      [create ? 'methodDefinitionsToCreate' : 'methodDefinitionsToUpdate']: [method],
    }] }] };
    let result;
    try {
      result = await shopifyGQL(shippingQueries.update, { id: args.profile_id, profile });
    } catch (error) {
      return { success: false, mutation_status: 'unknown', error: `Shipping write did not return a result: ${error.message}. Read the profile before retrying.` };
    }
    const payload = result.deliveryProfileUpdate;
    if (payload?.userErrors?.length) throw new Error(JSON.stringify(payload.userErrors));
    if (!payload?.profile) throw new Error('Shopify returned no updated shipping profile');
    // Once accepted, a readback failure must not invite a blind retry of a create.
    try {
      const after = await readProfile(args.profile_id);
      const saved = targetZone(after, args);
      const previousIds = new Set(entry.methodDefinitions.map(item => item.id));
      const candidates = create ? saved.methodDefinitions.filter(item => !previousIds.has(item.id)) : saved.methodDefinitions.filter(item => item.id === args.method_id);
      if (candidates.length !== 1) throw new Error('Could not identify exactly one persisted rate');
      const persisted = candidates[0];
      const withoutTarget = source => {
        const copy = structuredClone(source);
        const target = targetZone(copy, args);
        delete target.fingerprint;
        target.methodDefinitions = target.methodDefinitions.filter(item => item.id !== persisted.id);
        return canonical(copy);
      };
      if (JSON.stringify(withoutTarget(before)) !== JSON.stringify(withoutTarget(after))) throw new Error('Other shipping settings changed during the update');
      if (current) {
        for (const key of ['name', 'description', 'active', 'rateProvider']) {
          if ((key === 'rateProvider' ? !args.price : !Object.hasOwn(args, key)) && JSON.stringify(canonical(current[key])) !== JSON.stringify(canonical(persisted[key]))) throw new Error(`An omitted rate field changed: ${key}`);
        }
        const changedConditions = new Set((args.conditions_to_update || []).map(item => item.id));
        for (const condition of current.methodConditions) {
          if (!changedConditions.has(condition.id) && JSON.stringify(canonical(condition)) !== JSON.stringify(canonical(persisted.methodConditions.find(item => item.id === condition.id)))) throw new Error('An unrelated rate condition changed');
        }
      }
      for (const key of ['name', 'description', 'active']) if (Object.hasOwn(args, key) && persisted[key] !== args[key]) throw new Error(`Persisted rate ${key} does not match input`);
      if (args.price && (persisted.rateProvider.__typename !== 'DeliveryRateDefinition' || persisted.rateProvider.price.currencyCode !== args.price.currencyCode || !amountEqual(persisted.rateProvider.price.amount, args.price.amount))) throw new Error('Persisted shipping price does not match input');
      for (const update of args.conditions_to_update || []) {
        const condition = persisted.methodConditions.find(item => item.id === update.id);
        if (!condition || condition.operator !== update.operator || condition.conditionCriteria.currencyCode !== update.criteriaUnit || !amountEqual(condition.conditionCriteria.amount, update.criteria)) throw new Error('Persisted price condition does not match input');
      }
      for (const condition of args.price_conditions_to_create || []) {
        const oldIds = new Set(current?.methodConditions.map(item => item.id) || []);
        if (!persisted.methodConditions.some(item => !oldIds.has(item.id) && item.field === 'TOTAL_PRICE' && item.operator === condition.operator && item.conditionCriteria.currencyCode === condition.criteria.currencyCode && amountEqual(item.conditionCriteria.amount, condition.criteria.amount))) throw new Error('Persisted new price condition does not match input');
      }
      return { success: true, data: { before: entry, after: saved, method: persisted } };
    } catch (error) {
      return { success: false, mutation_applied: true, error: `Shipping update was accepted, but readback failed: ${error.message}. Read the profile before retrying.` };
    }
  }
  const implementations = {
    list_shipping_profiles: async args => {
      const result = await shopifyGQL(shippingQueries.list, { first: args.limit ?? 50, after: args.after ?? null, merchantOwnedOnly: args.merchant_owned_only ?? false });
      return { success: true, data: result.deliveryProfiles };
    },
    get_shipping_profile: async args => ({ success: true, data: await readProfile(args.profile_id) }),
    create_shipping_rate: args => writeRate(args, true),
    update_shipping_rate: args => writeRate(args, false),
  };
  return Object.fromEntries(shippingTools.map(tool => [tool.name, async (args = {}) => {
    try { validate(args, tool.inputSchema); return await implementations[tool.name](args); }
    catch (error) {
      const failure = { success: false, error: error.message };
      if (/ACCESS_DENIED|Access denied/i.test(error.message)) {
        try {
          const access = await shopifyGQL(shippingQueries.access);
          failure.granted_shipping_scopes = access.currentAppInstallation.accessScopes.map(scope => scope.handle).filter(scope => /shipping/.test(scope));
          failure.required_shipping_scopes = tool.name === 'list_shipping_profiles' || tool.name === 'get_shipping_profile' ? ['read_shipping'] : ['read_shipping', 'write_shipping'];
        } catch { /* Keep the original permission error if scope inspection also fails. */ }
      }
      return failure;
    }
  }]));
}
