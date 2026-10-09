// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/openapi/resolve-refs.js
function resolveRefs(document) {
  const root = document;
  const resolving = /* @__PURE__ */ new Set();
  const resolved2 = /* @__PURE__ */ new Map();
  function resolvePointer2(ref) {
    const segments = ref.replace(/^#\//, "").split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node = root;
    for (const segment of segments) {
      node = node[segment];
    }
    return node;
  }
  function walk(node) {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === "object") {
      const obj = node;
      const ref = obj["$ref"];
      if (typeof ref === "string") {
        if (!ref.startsWith("#/")) {
          return obj;
        }
        const target = resolvePointer2(ref);
        if (!target || typeof target !== "object") {
          return target;
        }
        if (resolved2.has(target)) {
          return resolved2.get(target);
        }
        if (resolving.has(target)) {
          return target;
        }
        resolving.add(target);
        const result2 = walk(target);
        resolving.delete(target);
        resolved2.set(target, result2);
        return result2;
      }
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = walk(value);
      }
      return result;
    }
    return node;
  }
  return walk(root);
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/resources/discover.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function updateMethodFor(paths, itemPath) {
  const item = paths[itemPath];
  if (isRecord(item) && !("put" in item) && "patch" in item) {
    return "PATCH";
  }
  return "PUT";
}
function discoverResources(paths) {
  const allPaths = Object.keys(paths);
  const collectionPaths = allPaths.filter((path) => !isItemPath(path));
  const resources = [];
  for (const collectionPath of collectionPaths) {
    const itemPath = allPaths.find((path) => isItemPath(path) && isDirectChild(collectionPath, path));
    if (itemPath) {
      resources.push({
        collectionPath,
        itemPath,
        itemParam: extractParamName(itemPath),
        updateMethod: updateMethodFor(paths, itemPath)
      });
    }
  }
  return resources;
}
function isItemPath(path) {
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== void 0 && last.startsWith("{") && last.endsWith("}");
}
function extractParamName(itemPath) {
  const segments = itemPath.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return last.slice(1, -1);
}
function isDirectChild(collectionPath, candidate) {
  const collectionSegments = collectionPath.split("/").filter(Boolean);
  const candidateSegments = candidate.split("/").filter(Boolean);
  return candidateSegments.length === collectionSegments.length + 1 && collectionSegments.every((segment, index) => segment === candidateSegments[index]);
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/model.js
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asText(value) {
  return typeof value === "string" ? value : value === null || value === void 0 ? "" : JSON.stringify(value);
}
function pathVariables(template) {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}
function crudResourcesOf(document) {
  const raw = document.components?.["crudResources"];
  if (!isRecord2(raw)) {
    throw new Error("OpenAPI document declares no crudResources; apply the CRUD-causality overlay");
  }
  return raw;
}
function listField(collection, standard) {
  const legacy = {
    listMethod: "x-list-method",
    listQuery: "x-list-query",
    listBody: "x-list-body"
  }[standard];
  return collection[standard] !== void 0 ? { name: standard, value: collection[standard] } : { name: legacy, value: collection[legacy] };
}
function listMethodOf(collection) {
  const { name, value: raw } = listField(collection, "listMethod");
  if (raw === void 0) {
    return "GET";
  }
  const method = typeof raw !== "string" ? "" : name === "listMethod" ? raw : raw.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error(`Unsupported ${name} ${asText(raw)}`);
  }
  return method;
}
function discoverReadModel(document, legacy) {
  if (legacy && document.components?.["crudResources"] === void 0) {
    return {
      collections: discoverResources(document.paths).map((route) => ({
        name: route.collectionPath,
        resource: route.collectionPath,
        url: route.collectionPath,
        idField: legacy.identityField ?? "id",
        contextParams: pathVariables(route.collectionPath),
        method: "GET",
        listQuery: {},
        listBody: {},
        itemUrl: route.itemPath,
        itemParam: route.itemParam
      })),
      providers: /* @__PURE__ */ new Map()
    };
  }
  const collections = [];
  const firstCollection = /* @__PURE__ */ new Map();
  const bindings = [];
  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord2(def)) {
      continue;
    }
    const identity = isRecord2(def["identity"]) ? def["identity"] : {};
    const itemUrl = typeof identity["urlTemplate"] === "string" ? identity["urlTemplate"] : "";
    const cols = isRecord2(def["collections"]) ? def["collections"] : {};
    const collectionUrlHas = (param) => Object.values(cols).some((c) => isRecord2(c) && typeof c["urlTemplate"] === "string" && c["urlTemplate"].includes(`{${param}}`));
    let idField = "id";
    let itemParam;
    const identityBindings = isRecord2(identity["bindings"]) ? identity["bindings"] : {};
    for (const [param, binding] of Object.entries(identityBindings)) {
      const field = isRecord2(binding) && typeof binding["field"] === "string" ? binding["field"] : "id";
      bindings.push({ param, resource, field });
      if (itemUrl.includes(`{${param}}`) && !collectionUrlHas(param)) {
        idField = field;
        itemParam = param;
      }
    }
    for (const [name, col] of Object.entries(cols)) {
      if (!isRecord2(col) || typeof col["urlTemplate"] !== "string") {
        continue;
      }
      if (!firstCollection.has(resource)) {
        firstCollection.set(resource, name);
      }
      const listQuery = {};
      const query = listField(col, "listQuery").value;
      if (isRecord2(query)) {
        for (const [key, value] of Object.entries(query)) {
          listQuery[key] = asText(value);
        }
      }
      const body = listField(col, "listBody").value;
      const itemsField = isRecord2(col["envelope"]) ? col["envelope"]["itemsField"] : void 0;
      collections.push({
        name,
        resource,
        url: col["urlTemplate"],
        idField,
        contextParams: pathVariables(col["urlTemplate"]),
        listQuery,
        method: listMethodOf(col),
        listBody: isRecord2(body) ? structuredClone(body) : {},
        ...typeof itemsField === "string" || itemsField === null ? { itemsField: itemsField ?? "" } : {},
        ...itemUrl ? { itemUrl } : {},
        ...itemParam ? { itemParam } : {}
      });
    }
  }
  const providers = /* @__PURE__ */ new Map();
  for (const { param, resource, field } of bindings) {
    const collection = firstCollection.get(resource);
    if (collection && !providers.has(param)) {
      providers.set(param, { collection, field });
    }
  }
  return { collections, providers };
}
function rootParameters(model) {
  const parameters = /* @__PURE__ */ new Set();
  for (const collection of model.collections) {
    for (const param of collection.contextParams) {
      const provider = model.providers.get(param);
      if (!provider || provider.collection === collection.name) {
        parameters.add(param);
      }
    }
  }
  return [...parameters].sort();
}
function upstreamOf(document) {
  const servers = document["servers"];
  const first = Array.isArray(servers) ? servers[0] : void 0;
  const raw = isRecord2(first) ? first["url"] : void 0;
  if (typeof raw !== "string" || !raw) {
    throw new Error("OpenAPI document declares no servers");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAPI server must be an HTTP(S) URL");
  }
  return url;
}
function listOperation(document, path, method) {
  const operation = document.paths?.[path]?.[method === "POST" ? "post" : "get"];
  return isRecord2(operation) ? operation : void 0;
}
function declaredQueryParameters(operation) {
  return new Set((operation.parameters ?? []).filter((parameter) => isRecord2(parameter) && parameter.in === "query").map((parameter) => parameter.name));
}
function describeModel(document, model) {
  return {
    parameters: rootParameters(model),
    collections: model.collections.map((c) => c.name),
    upstream: upstreamOf(document).href
  };
}
function applySelection(document, model, selection) {
  for (const override of selection?.query_overrides ?? []) {
    const matches = model.collections.filter((c) => c.url === override.path);
    const collection = matches[0];
    if (matches.length !== 1 || !collection) {
      throw new Error(`Unknown or ambiguous collection path ${override.path}`);
    }
    const operation = listOperation(document, override.path, collection.method);
    if (!operation) {
      throw new Error(`Collection ${override.path} has no ${collection.method} operation`);
    }
    const declared = declaredQueryParameters(operation);
    for (const [name, value] of Object.entries(override.values)) {
      if (!declared.has(name)) {
        throw new Error(`Unknown query parameter ${name} for ${override.path}`);
      }
      collection.listQuery[name] = asText(value);
    }
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/ontology.js
var DATATYPES = {
  string: "https://atomicdata.dev/datatypes/string",
  timestamp: "https://atomicdata.dev/datatypes/timestamp",
  date: "https://atomicdata.dev/datatypes/date",
  integer: "https://atomicdata.dev/datatypes/integer",
  float: "https://atomicdata.dev/datatypes/float",
  boolean: "https://atomicdata.dev/datatypes/boolean",
  json: "https://atomicdata.dev/datatypes/json"
};
function ontologyShortname(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-");
}
function datatypeOf(schema) {
  switch (schema?.type) {
    case "string":
      return schema.format === "date-time" ? DATATYPES.timestamp : schema.format === "date" ? DATATYPES.date : DATATYPES.string;
    case "integer":
      return DATATYPES.integer;
    case "number":
      return DATATYPES.float;
    case "boolean":
      return DATATYPES.boolean;
    default:
      return void 0;
  }
}
function flattenSchema(schema) {
  if (!schema?.allOf) {
    return schema ?? {};
  }
  const { allOf, ...rest } = schema;
  return allOf.map(flattenSchema).reduce((merged, branch) => ({
    ...merged,
    required: [...merged.required ?? [], ...branch.required ?? []],
    properties: { ...merged.properties, ...branch.properties }
  }), rest);
}
function claim(claimed, original) {
  const shortname = ontologyShortname(original);
  const existing = claimed.get(shortname);
  if (existing !== void 0 && existing !== original) {
    throw new Error(`Ontology shortname ${shortname} is claimed by both ${existing} and ${original}`);
  }
  claimed.set(shortname, original);
  return shortname;
}
function deriveOntology(document) {
  const title = document.info?.title?.trim() ?? "";
  const base = title ? ontologyShortname(title) : "ontology";
  const terms = [];
  const classNames = /* @__PURE__ */ new Map();
  const propertyNames = /* @__PURE__ */ new Map();
  const propertyIndex = /* @__PURE__ */ new Map();
  const agreed = /* @__PURE__ */ new Map();
  for (const [resource, def] of Object.entries(crudResourcesOf(document))) {
    if (!isRecord2(def)) {
      continue;
    }
    const classShortname = claim(classNames, resource);
    const schema = flattenSchema(def["schema"]);
    const required = new Set(schema.required ?? []);
    const requires = [];
    const recommends = [];
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      const shortname = claim(propertyNames, field);
      const datatype = datatypeOf(fieldSchema);
      let index = propertyIndex.get(shortname);
      if (index === void 0) {
        index = terms.length;
        propertyIndex.set(shortname, index);
        agreed.set(index, datatype);
        terms.push({
          path: `${base}/property/${shortname}`,
          kind: "property",
          shortname,
          description: typeof fieldSchema.description === "string" ? fieldSchema.description : `\`${field}\` of \`${resource}\`.`,
          datatype: datatype ?? DATATYPES.json,
          requires: [],
          recommends: []
        });
      } else if (agreed.get(index) !== datatype) {
        agreed.set(index, void 0);
        terms[index].datatype = DATATYPES.json;
      }
      (required.has(field) ? requires : recommends).push(terms[index].path);
    }
    terms.push({
      path: `${base}/class/${classShortname}`,
      kind: "class",
      shortname: classShortname,
      description: typeof def["description"] === "string" ? def["description"] : `The \`${resource}\` resource.`,
      datatype: DATATYPES.json,
      requires,
      recommends
    });
  }
  return {
    description: title ? `Derived from the "${title}" OpenAPI document.` : "Derived from an OpenAPI document.",
    terms
  };
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/validate.js
var SCHEME_TYPES = /* @__PURE__ */ new Set([
  "pageNumber",
  "pageToken",
  "nextLink",
  "rangeWindow"
]);
var WINDOW_UNITS = /* @__PURE__ */ new Set(["day", "second", "integer"]);
var WINDOW_FORMATS = {
  date: "day",
  basicDate: "day",
  dateTime: "second",
  unixSeconds: "second",
  integer: "integer"
};
var WINDOW_BOUNDS = /* @__PURE__ */ new Set(["closed", "halfOpen"]);
var WINDOW_ROLES = /* @__PURE__ */ new Set(["windowStart", "windowEnd", "windowRange"]);
var REQUEST_ROLES = /* @__PURE__ */ new Set([
  "page",
  "pageSize",
  "offset",
  "pageToken",
  "cursor",
  "previousPageToken",
  "syncToken",
  "windowStart",
  "windowEnd",
  "windowRange"
]);
var RESPONSE_ROLES = /* @__PURE__ */ new Set([
  "nextPageToken",
  "nextCursor",
  "nextLink",
  "previousPageToken",
  "previousLink",
  "nextSyncToken",
  "totalCount",
  "totalPages",
  "pageSize",
  "currentPage",
  "offset"
]);
var LINK_BASES = /* @__PURE__ */ new Set(["request", "server", "declared"]);
function isExtensionKey(key) {
  return key.startsWith("x-");
}
var WINDOW_KEYS = /* @__PURE__ */ new Set([
  "unit",
  "format",
  "bounds",
  "cap",
  "minimumWidth",
  "field",
  "timeZone",
  "description"
]);
var TEMPLATE = /^(?:[^{}]*\{start\}[^{}]*\{end\}[^{}]*|[^{}]*\{end\}[^{}]*\{start\}[^{}]*)$/;
var JSON_POINTER = /^(\/([^~]|~[01])*)*$/;
var REQUEST_LOCATIONS = [
  "queryParameters",
  "bodyFields",
  "headerFields"
];
var isPositiveInteger = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1;
function checkWindow(path, scheme, errors) {
  const fields = REQUEST_LOCATIONS.flatMap((location) => Object.entries(scheme.request?.[location] ?? {}).map(([name, field]) => ({
    at: `${path}.request.${location}.${name}`,
    field
  })));
  for (const { at, field } of fields) {
    const role = String(field.role);
    if (field.template !== void 0) {
      if (role !== "windowRange") {
        errors.push(`${at}.template is allowed only on a windowRange field`);
      } else if (typeof field.template !== "string" || !TEMPLATE.test(field.template)) {
        errors.push(`${at}.template must hold {start} and {end} once each and no other brace`);
      }
    } else if (role === "windowRange") {
      errors.push(`${at} has role windowRange and needs a template`);
    }
  }
  if (scheme.type !== "rangeWindow") {
    if (scheme.window !== void 0) {
      errors.push(`${path}.window is allowed only on a rangeWindow scheme`);
    }
    for (const { at, field } of fields) {
      if (WINDOW_ROLES.has(String(field.role))) {
        errors.push(`${at}.role ${String(field.role)} is allowed only in a rangeWindow scheme`);
      }
    }
    return;
  }
  if (scheme.autoDetect !== void 0 && scheme.autoDetect !== false) {
    errors.push(`${path}.autoDetect must be false: a rangeWindow scheme is never auto-detected`);
  }
  if (!scheme.request) {
    errors.push(`${path} is a rangeWindow scheme and needs a request`);
  }
  const roles = fields.map(({ field }) => String(field.role)).filter((role) => WINDOW_ROLES.has(role)).sort();
  const carried = roles.length === 1 && roles[0] === "windowRange" || roles.length === 2 && roles[0] === "windowEnd" && roles[1] === "windowStart";
  if (!carried) {
    errors.push(`${path}.request needs one windowRange field, or one windowStart and one windowEnd field (found ${roles.join(", ") || "none"})`);
  }
  const window = scheme.window;
  if (typeof window !== "object" || window === null || Array.isArray(window)) {
    errors.push(`${path}.window is required for a rangeWindow scheme`);
    return;
  }
  const w = window;
  for (const key of Object.keys(w)) {
    if (!WINDOW_KEYS.has(key) && !isExtensionKey(key)) {
      errors.push(`${path}.window.${key} is not a Range Window Object field`);
    }
  }
  if (typeof w["unit"] !== "string" || !WINDOW_UNITS.has(w["unit"])) {
    errors.push(`${path}.window.unit must be one of day, second, or integer`);
  }
  const fits = WINDOW_FORMATS[String(w["format"])];
  if (fits === void 0) {
    errors.push(`${path}.window.format must be one of date, basicDate, dateTime, unixSeconds, or integer`);
  } else if (fits !== w["unit"]) {
    errors.push(`${path}.window.format ${String(w["format"])} does not fit unit ${String(w["unit"])}`);
  }
  if (typeof w["bounds"] !== "string" || !WINDOW_BOUNDS.has(w["bounds"])) {
    errors.push(`${path}.window.bounds must be closed or halfOpen`);
  }
  if (!isPositiveInteger(w["cap"])) {
    errors.push(`${path}.window.cap must be an integer of at least 1`);
  }
  if (w["minimumWidth"] !== void 0 && !isPositiveInteger(w["minimumWidth"])) {
    errors.push(`${path}.window.minimumWidth must be an integer of at least 1`);
  }
  if (w["field"] !== void 0 && (typeof w["field"] !== "string" || !JSON_POINTER.test(w["field"]))) {
    errors.push(`${path}.window.field must be a JSON Pointer`);
  }
  if (w["timeZone"] !== void 0) {
    if (w["unit"] !== "day") {
      errors.push(`${path}.window.timeZone is allowed only with unit day`);
    } else if (typeof w["timeZone"] !== "string" || w["timeZone"] === "") {
      errors.push(`${path}.window.timeZone must be a nonempty string`);
    }
  }
}
function checkLinkResolution(path, field, errors) {
  const resolution = field.linkResolution;
  if (resolution === void 0)
    return;
  if (field.role !== "nextLink" && field.role !== "previousLink") {
    errors.push(`${path}.linkResolution is allowed only on a nextLink or previousLink field`);
  }
  if (typeof resolution !== "object" || resolution === null) {
    errors.push(`${path}.linkResolution must be an object`);
    return;
  }
  const { base, url } = resolution;
  if (typeof base !== "string" || !LINK_BASES.has(base)) {
    errors.push(`${path}.linkResolution.base must be one of request, server, or declared (got "${String(base)}")`);
  }
  if (base === "declared") {
    if (typeof url !== "string" || !isAbsoluteHttpUrl(url)) {
      errors.push(`${path}.linkResolution.url must be an absolute http or https URL without userinfo or a fragment when base is declared`);
    }
  } else if (url !== void 0) {
    errors.push(`${path}.linkResolution.url is allowed only when base is declared`);
  }
}
var DECLARED_URL = /^https?:\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/;
function isAbsoluteHttpUrl(value) {
  return DECLARED_URL.test(value);
}
function checkEnvelope(path, envelope, errors) {
  if (envelope === void 0)
    return;
  if (typeof envelope !== "object" || envelope === null) {
    errors.push(`${path}.envelope must be an object`);
    return;
  }
  const field = envelope["itemsField"];
  if (field !== void 0 && field !== null && typeof field !== "string")
    errors.push(`${path}.envelope.itemsField must be a string or null`);
}
function validatePaginationScheme(name, scheme) {
  const errors = [];
  const path = `paginationSchemes.${name}`;
  if (!SCHEME_TYPES.has(scheme.type)) {
    errors.push(`${path}.type must be one of pageNumber, pageToken, nextLink, or rangeWindow (got "${String(scheme.type)}")`);
  }
  checkWindow(path, scheme, errors);
  if (!scheme.request && !scheme.response) {
    errors.push(`${path} must define at least one of "request" or "response"`);
  }
  for (const [fieldName, field] of Object.entries(scheme.request?.queryParameters ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !REQUEST_ROLES.has(field.role)) {
      errors.push(`${path}.request.queryParameters.${fieldName}.role is not a valid request role (got "${field.role}")`);
    }
  }
  for (const [fieldName, field] of Object.entries(scheme.request?.bodyFields ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !REQUEST_ROLES.has(field.role)) {
      errors.push(`${path}.request.bodyFields.${fieldName}.role is not a valid request role (got "${field.role}")`);
    }
  }
  checkEnvelope(`${path}.response`, scheme.response?.envelope, errors);
  for (const [fieldName, field] of Object.entries(scheme.response?.bodyFields ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !RESPONSE_ROLES.has(field.role)) {
      errors.push(`${path}.response.bodyFields.${fieldName}.role is not a valid response role (got "${field.role}")`);
    }
    checkLinkResolution(`${path}.response.bodyFields.${fieldName}`, field, errors);
  }
  for (const [fieldName, field] of Object.entries(scheme.response?.headers ?? {})) {
    if (field.role && !isExtensionKey(field.role) && !RESPONSE_ROLES.has(field.role)) {
      errors.push(`${path}.response.headers.${fieldName}.role is not a valid response role (got "${field.role}")`);
    }
    checkLinkResolution(`${path}.response.headers.${fieldName}`, field, errors);
  }
  return errors;
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/autodetect.js
var PaginationSchemeError = class extends Error {
};
function validSchemes(document) {
  const map = /* @__PURE__ */ new Map();
  const schemes = document.components?.paginationSchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (validatePaginationScheme(name, scheme).length === 0) {
      map.set(name, scheme);
    }
  }
  return map;
}
function queryParamNames(operation) {
  return new Set((operation.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name));
}
function bodyFieldNames(operation) {
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  return new Set(Object.keys(schema?.properties ?? {}));
}
function autoDetectMatches(scheme, operation) {
  if (scheme.autoDetect === false || scheme.type === "rangeWindow") {
    return false;
  }
  const options = typeof scheme.autoDetect === "object" ? scheme.autoDetect : {};
  const requireAll = options.requireAll ?? true;
  const results = [];
  if (options.matchQueryParams ?? true) {
    const required = Object.keys(scheme.request?.queryParameters ?? {});
    if (required.length > 0) {
      const declared = queryParamNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }
  if (options.matchBodyFields ?? true) {
    const required = Object.keys(scheme.request?.bodyFields ?? {});
    if (required.length > 0) {
      const declared = bodyFieldNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }
  if (results.length === 0) {
    return false;
  }
  return requireAll ? results.every(Boolean) : results.some(Boolean);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, overrides) {
  const result = {
    ...base
  };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}
function resolveEffectiveScheme(document, operation) {
  const schemes = validSchemes(document);
  const explicit = operation["x-pagination"];
  if (explicit !== void 0 && !Array.isArray(explicit)) {
    throw new PaginationSchemeError("x-pagination must be an array of Pagination Application Objects");
  }
  if (Array.isArray(explicit) && explicit.length > 0) {
    const application = explicit[0];
    if (!isPlainObject(application) || typeof application.scheme !== "string") {
      throw new PaginationSchemeError('x-pagination[0] must be a Pagination Application Object with a "scheme" name');
    }
    const name = application.scheme;
    const declared = document.components?.paginationSchemes?.[name];
    if (!declared) {
      throw new PaginationSchemeError(`x-pagination names the pagination scheme "${name}", which the document does not declare`);
    }
    const invalid = validatePaginationScheme(name, declared);
    if (invalid.length) {
      throw new PaginationSchemeError(`x-pagination names the pagination scheme "${name}", which is invalid: ${invalid.join("; ")}`);
    }
    const scheme = application.overrides ? deepMerge(declared, application.overrides) : declared;
    const afterMerge = application.overrides ? validatePaginationScheme(name, scheme) : [];
    if (afterMerge.length) {
      throw new PaginationSchemeError(`x-pagination's overrides make the pagination scheme "${name}" invalid: ${afterMerge.join("; ")}`);
    }
    const windowed = explicit.some((entry) => {
      if (!isPlainObject(entry))
        return false;
      const overrides = entry["overrides"];
      const type = isPlainObject(overrides) && "type" in overrides ? overrides["type"] : document.components?.paginationSchemes?.[String(entry["scheme"])]?.type;
      return type === "rangeWindow";
    });
    if (windowed && explicit.length > 1) {
      throw new PaginationSchemeError("x-pagination applies a rangeWindow scheme together with another scheme");
    }
    return { schemeName: name, scheme };
  }
  for (const [schemeName, scheme] of schemes) {
    if (autoDetectMatches(scheme, operation)) {
      return { schemeName, scheme };
    }
  }
  return void 0;
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/items.js
var COMMON_ITEMS_FIELDS = ["items", "data", "results", "records", "content"];
function effectiveProperties(schema) {
  if (!schema) {
    return {};
  }
  if (schema.allOf) {
    return schema.allOf.reduce((merged, branch) => ({ ...merged, ...effectiveProperties(branch) }), {});
  }
  return { ...schema.properties ?? {} };
}
function metadataFieldRoots(scheme) {
  const roots = /* @__PURE__ */ new Set();
  for (const key of Object.keys(scheme?.response?.bodyFields ?? {})) {
    roots.add(key.split(".")[0] ?? key);
  }
  return roots;
}
function locateItemsField(schema, scheme) {
  const properties = effectiveProperties(schema);
  const excluded = metadataFieldRoots(scheme);
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!excluded.has(name) && propertySchema.type === "array") {
      return name;
    }
  }
  return COMMON_ITEMS_FIELDS.find((name) => name in properties && !excluded.has(name));
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/links.js
var LinkRefused = class extends Error {
};
var UNFOLLOWABLE = /[\s\x00-\x1f\x7f\\]|[^\x00-\x7f]/;
var SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
var SCHEME_WITH_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]/;
var EMPTY_AUTHORITY = /^\/\/(?:$|\/)/;
var refused = (reason) => new LinkRefused(`Pagination link refused: ${reason}`);
function resolveLink(value, options) {
  if (value === null || value === void 0 || value === "")
    return null;
  if (typeof value !== "string")
    throw refused("the link is not a string");
  if (UNFOLLOWABLE.test(value))
    throw refused("the link contains whitespace, a control character, a backslash or a non-ASCII character");
  if (value.startsWith("///"))
    throw refused("the link starts with three or more slashes");
  if (SCHEME.test(value) && !SCHEME_WITH_AUTHORITY.test(value))
    throw refused('the link has a scheme without "//" and an authority');
  if (EMPTY_AUTHORITY.test(value))
    throw refused("the link has an empty authority");
  if (RAW_AUTHORITY.exec(value)?.[1]?.includes("@"))
    throw refused("the link contains userinfo");
  if (value.includes("#"))
    throw refused("the link contains a fragment");
  if (!isHttp(options.serverUrl))
    throw refused("the server URL is not http or https");
  const base = baseFor(options);
  let resolved2;
  try {
    resolved2 = new URL(value, base);
  } catch {
    throw refused(`${value} does not resolve to a URL`);
  }
  if (resolved2.username || resolved2.password)
    throw refused("the link contains userinfo");
  if (resolved2.hash || resolved2.href.includes("#"))
    throw refused("the link contains a fragment");
  if (!isHttp(resolved2) || resolved2.origin !== options.serverUrl.origin)
    throw new LinkRefused("Pagination left the API origin");
  return resolved2;
}
var RAW_AUTHORITY = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)/;
var isHttp = (url) => url.protocol === "https:" || url.protocol === "http:";
function baseFor({ requestUrl, serverUrl, resolution }) {
  const base = resolution?.base ?? "request";
  if (base === "request")
    return requestUrl;
  if (base === "server") {
    const directory = new URL(serverUrl.href);
    if (!directory.pathname.endsWith("/"))
      directory.pathname += "/";
    return directory;
  }
  if (base === "declared") {
    if (typeof resolution?.url !== "string" || resolution.url === "")
      throw refused('linkResolution base "declared" has no url');
    try {
      return new URL(resolution.url);
    } catch {
      throw refused(`linkResolution url ${resolution.url} is not an absolute URL`);
    }
  }
  throw refused(`unknown linkResolution base "${String(base)}"`);
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/throttling/throttling.js
var ROLES = /* @__PURE__ */ new Set([
  "limit",
  "remaining",
  "used",
  "reset",
  "retryAfter"
]);
var TIMED_ROLES = /* @__PURE__ */ new Set(["reset", "retryAfter"]);
var UNITS = /* @__PURE__ */ new Set([
  "epochSeconds",
  "deltaSeconds",
  "httpDate",
  "deltaSecondsOrHttpDate"
]);
var MEANINGS = /* @__PURE__ */ new Set(["throttled", "quotaExhausted"]);
var isScalar = (value) => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
var isPositiveInteger2 = (value) => typeof value === "number" && Number.isInteger(value) && value > 0;
function declaredThrottling(document) {
  const root = document["x-throttling"];
  if (!isRecord2(root))
    return void 0;
  const windows = /* @__PURE__ */ new Map();
  if (isRecord2(root["limits"]))
    for (const [name, limit] of Object.entries(root["limits"])) {
      const window = isRecord2(limit) ? limit["window"] : void 0;
      const seconds = isRecord2(window) ? window["seconds"] : void 0;
      if (isPositiveInteger2(seconds))
        windows.set(name, seconds);
    }
  const applies = Array.isArray(root["applies"]) ? root["applies"].filter((b) => typeof b === "string") : [];
  const headers = /* @__PURE__ */ new Map();
  const rolesSeen = /* @__PURE__ */ new Set();
  if (isRecord2(root["headers"]))
    for (const [name, value] of Object.entries(root["headers"])) {
      const key = name.toLowerCase();
      if (!isRecord2(value) || headers.has(key))
        continue;
      const { role, unit, description } = value;
      if (typeof role !== "string" || !ROLES.has(role) || rolesSeen.has(role))
        continue;
      if (TIMED_ROLES.has(role)) {
        if (typeof unit !== "string" || !UNITS.has(unit))
          continue;
      } else if (unit !== void 0)
        continue;
      rolesSeen.add(role);
      headers.set(key, {
        role,
        ...typeof unit === "string" ? { unit } : {},
        ...typeof description === "string" ? { description } : {}
      });
    }
  const declaration = { windows, applies, headers };
  if (Array.isArray(root["signals"]) && root["signals"].length) {
    const signals = root["signals"].map(parseSignal);
    if (signals.every((s) => s !== void 0))
      declaration.signals = signals;
  }
  return declaration;
}
function parseSignal(value) {
  if (!isRecord2(value))
    return void 0;
  const { status, header, body, meaning, bucket, minDelaySeconds, description } = value;
  if (!Array.isArray(status) || !status.length || !status.every((s) => Number.isInteger(s) && s >= 100 && s <= 599))
    return void 0;
  if (typeof meaning !== "string" || !MEANINGS.has(meaning))
    return void 0;
  const signal = {
    status: [...status],
    meaning
  };
  if (header !== void 0) {
    const parsed = parseHeaderPredicate(header);
    if (!parsed)
      return void 0;
    signal.header = parsed;
  }
  if (body !== void 0) {
    const parsed = parseBodyPredicate(body);
    if (!parsed)
      return void 0;
    signal.body = parsed;
  }
  if (bucket !== void 0) {
    if (typeof bucket !== "string")
      return void 0;
    signal.bucket = bucket;
  }
  if (minDelaySeconds !== void 0) {
    if (!isPositiveInteger2(minDelaySeconds))
      return void 0;
    signal.minDelaySeconds = minDelaySeconds;
  }
  if (typeof description === "string")
    signal.description = description;
  return signal;
}
function oneOperator(value, operators) {
  const present = operators.filter((op) => value[op] !== void 0);
  return present.length === 1 ? present[0] : void 0;
}
function parseHeaderPredicate(value) {
  if (!isRecord2(value) || typeof value["name"] !== "string")
    return void 0;
  const name = value["name"];
  switch (oneOperator(value, ["equals", "in", "present"])) {
    case "equals":
      return typeof value["equals"] === "string" ? { name, equals: value["equals"] } : void 0;
    case "in": {
      const list = value["in"];
      return Array.isArray(list) && list.length && list.every((v) => typeof v === "string") ? { name, in: [...list] } : void 0;
    }
    case "present":
      return value["present"] === true ? { name, present: true } : void 0;
    default:
      return void 0;
  }
}
var POINTER = /^(\/([^~/]|~[01])*)*$/;
function parseBodyPredicate(value) {
  if (!isRecord2(value) || typeof value["pointer"] !== "string")
    return void 0;
  const pointer = value["pointer"];
  if (!POINTER.test(pointer))
    return void 0;
  switch (oneOperator(value, ["equals", "in", "contains", "present", "item"])) {
    case "equals":
      return isScalar(value["equals"]) ? { pointer, equals: value["equals"] } : void 0;
    case "in": {
      const list = value["in"];
      return Array.isArray(list) && list.length && list.every(isScalar) ? { pointer, in: [...list] } : void 0;
    }
    case "contains":
      return typeof value["contains"] === "string" ? { pointer, contains: value["contains"] } : void 0;
    case "present":
      return value["present"] === true ? { pointer, present: true } : void 0;
    case "item": {
      const item = parseBodyPredicate(value["item"]);
      return item ? { pointer, item } : void 0;
    }
    default:
      return void 0;
  }
}
var MISSING = /* @__PURE__ */ Symbol("missing");
function resolvePointer(value, pointer) {
  if (pointer === "")
    return value;
  let node = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isRecord2(node) && Object.prototype.hasOwnProperty.call(node, token)) {
      node = node[token];
    } else if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(token) && Number(token) < node.length) {
      node = node[Number(token)];
    } else {
      return MISSING;
    }
  }
  return node;
}
var jsonEqual = (a, b) => a === b || typeof a === "number" && typeof b === "number" && a === b;
function bodyMatches(predicate, body) {
  const value = resolvePointer(body, predicate.pointer);
  if (value === MISSING)
    return false;
  if ("present" in predicate)
    return true;
  if ("equals" in predicate)
    return jsonEqual(value, predicate.equals);
  if ("in" in predicate)
    return predicate.in.some((v) => jsonEqual(value, v));
  if ("contains" in predicate)
    return typeof value === "string" && value.toLowerCase().includes(predicate.contains.toLowerCase());
  return Array.isArray(value) && value.some((element) => bodyMatches(predicate.item, element));
}
function headerValue(headers, name) {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === key)
      return typeof v === "string" ? v.trim() : void 0;
  return void 0;
}
function headerMatches(predicate, headers) {
  const value = headerValue(headers, predicate.name);
  if (value === void 0)
    return false;
  if ("present" in predicate)
    return true;
  if ("equals" in predicate)
    return value === predicate.equals;
  return predicate.in.includes(value);
}
function integer(value) {
  if (!/^[0-9]+$/.test(value))
    return void 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : void 0;
}
function httpDate(value) {
  if (!/[a-zA-Z]/.test(value))
    return void 0;
  const zoned = /(GMT|UTC|UT|[+-][0-9]{2}:?[0-9]{2})\s*$/i.test(value);
  const ms = Date.parse(zoned ? value : `${value} GMT`);
  return Number.isFinite(ms) ? ms : void 0;
}
function headerTime(value, unit, receivedAt, dateHeader) {
  if (unit === "deltaSeconds" || unit === "deltaSecondsOrHttpDate") {
    const delta = integer(value);
    if (delta !== void 0)
      return receivedAt + delta * 1e3;
    if (unit === "deltaSeconds")
      return void 0;
  }
  let absolute;
  if (unit === "epochSeconds") {
    const seconds = integer(value);
    absolute = seconds === void 0 ? void 0 : seconds * 1e3;
  } else {
    absolute = httpDate(value);
  }
  if (absolute === void 0)
    return void 0;
  const serverNow = dateHeader === void 0 ? void 0 : httpDate(dateHeader);
  return serverNow === void 0 ? absolute : Math.max(absolute, receivedAt + (absolute - serverNow));
}
var STANDARD_RETRY_AFTER = {
  role: "retryAfter",
  unit: "deltaSecondsOrHttpDate"
};
function classifyThrottling(declaration, response) {
  const receivedAt = response.receivedAt ?? Date.now();
  const headers = response.headers;
  let body = MISSING;
  const parsedBody = () => {
    if (body === MISSING) {
      try {
        body = response.body === void 0 ? void 0 : JSON.parse(response.body);
      } catch {
        body = void 0;
      }
    }
    return body;
  };
  let signal;
  for (const candidate of declaration?.signals ?? []) {
    if (!candidate.status.includes(response.status))
      continue;
    if (candidate.header && !headerMatches(candidate.header, headers))
      continue;
    if (candidate.body) {
      const json = parsedBody();
      if (json === void 0 || !bodyMatches(candidate.body, json))
        continue;
    }
    signal = candidate;
    break;
  }
  if (!signal && response.status !== 429)
    return void 0;
  const meaning = signal?.meaning ?? "throttled";
  const roles = /* @__PURE__ */ new Map();
  const declared = declaration?.headers ?? /* @__PURE__ */ new Map();
  for (const [name, header] of declared) {
    const value = headerValue(headers, name);
    if (value === void 0)
      continue;
    const entry = { value };
    if (header.unit)
      entry.unit = header.unit;
    roles.set(header.role, entry);
  }
  if (![...declared.values()].some((h) => h.role === "retryAfter")) {
    const value = headerValue(headers, "retry-after");
    if (value !== void 0)
      roles.set("retryAfter", {
        value,
        unit: STANDARD_RETRY_AFTER.unit
      });
  }
  const dateHeader = headerValue(headers, "date");
  const times = [];
  const retryAfter = roles.get("retryAfter");
  if (retryAfter?.unit) {
    const t = headerTime(retryAfter.value, retryAfter.unit, receivedAt, dateHeader);
    if (t !== void 0)
      times.push(t);
  }
  const remaining = roles.get("remaining");
  const exhausted = meaning === "quotaExhausted" || remaining !== void 0 && integer(remaining.value) === 0;
  const reset = roles.get("reset");
  if (exhausted && reset?.unit) {
    const t = headerTime(reset.value, reset.unit, receivedAt, dateHeader);
    if (t !== void 0)
      times.push(t);
  }
  const verdict = { meaning };
  if (signal)
    verdict.signal = signal;
  if (signal?.bucket !== void 0)
    verdict.bucket = signal.bucket;
  if (times.length)
    verdict.retryAt = Math.max(...times);
  else if (signal?.minDelaySeconds !== void 0)
    verdict.retryAt = receivedAt + signal.minDelaySeconds * 1e3;
  else if (meaning === "quotaExhausted" && signal?.bucket !== void 0) {
    const window = declaration?.windows.get(signal.bucket);
    if (window !== void 0)
      verdict.retryAt = receivedAt + window * 1e3;
  }
  return verdict;
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/response-parser.js
function splitPath(path) {
  const segments = [];
  const pattern = /\[\s*"((?:[^"\\]|\\.)*)"\s*\]|([^.[]+)|(\.)|(\[)/g;
  let expectDot = false;
  for (const match of path.matchAll(pattern)) {
    const [, quoted, plain, dot, bracket] = match;
    if (quoted !== void 0) {
      segments.push(quoted.replace(/\\(.)/g, "$1"));
      expectDot = true;
    } else if (plain !== void 0) {
      segments.push(plain);
      expectDot = true;
    } else if (dot !== void 0) {
      if (!expectDot)
        segments.push("");
      expectDot = false;
    } else if (bracket !== void 0) {
      throw new Error(`Malformed dot-path ${JSON.stringify(path)}`);
    }
  }
  if (!expectDot)
    segments.push("");
  return segments;
}
function readNestedField(body, path) {
  let node = body;
  for (const segment of splitPath(path)) {
    if (typeof node !== "object" || node === null) {
      return void 0;
    }
    node = node[segment];
  }
  return node;
}
function setNestedField(body, path, value) {
  const segments = splitPath(path);
  let node = body;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const child = node[segment];
    if (typeof child !== "object" || child === null) {
      node[segment] = {};
    }
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
}
function parseLinkHeader(header, relation = "next") {
  if (!header) {
    return null;
  }
  const wanted = relation.toLowerCase();
  const parts = header.split(/,\s*(?=<)/);
  for (const part of parts) {
    const match = part.match(/^\s*<([^>]*)>(.*)$/s);
    if (!match) {
      continue;
    }
    const [, url, attrs] = match;
    const rel = attrs?.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s"]+))/i);
    if (!rel) {
      continue;
    }
    const types = (rel[1] ?? rel[2] ?? "").trim().split(/\s+/).map((type) => type.toLowerCase());
    if (types.includes(wanted)) {
      return url ? url : null;
    }
  }
  return null;
}
function toStringOrNull(value) {
  if (value === null || value === void 0 || value === "") {
    return null;
  }
  return String(value);
}
function toNumberOrNull(value) {
  if (value === null || value === void 0) {
    return null;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
function extractByRole(scheme, body, headers) {
  const roles = /* @__PURE__ */ new Map();
  let nextLinkResolution = null;
  for (const [path, field] of Object.entries(scheme.response?.bodyFields ?? {})) {
    if (!field.role)
      continue;
    const value = readNestedField(body, path);
    if (value !== void 0) {
      roles.set(field.role, value);
      if (field.role === "nextLink")
        nextLinkResolution = field.linkResolution ?? null;
    }
  }
  for (const [name, field] of Object.entries(scheme.response?.headers ?? {})) {
    if (!field.role)
      continue;
    const raw = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (raw === void 0)
      continue;
    if (field.role === "nextLink") {
      const parsed = parseLinkHeader(raw);
      if (parsed) {
        roles.set("nextLink", parsed);
        nextLinkResolution = field.linkResolution ?? null;
      }
    } else {
      roles.set(field.role, raw);
    }
  }
  return { roles, nextLinkResolution };
}
function deriveHasNextPage(type, state, itemsFetchedSoFar) {
  if (state.nextLink !== null || state.nextPageToken !== null) {
    return true;
  }
  if (state.totalCount !== null && itemsFetchedSoFar !== void 0) {
    return itemsFetchedSoFar < state.totalCount;
  }
  if (type === "pageNumber") {
    if (state.currentPage !== null && state.totalPages !== null) {
      return state.currentPage < state.totalPages;
    }
    if (state.currentPage !== null && state.totalCount !== null && state.pageSize !== null) {
      return state.currentPage * state.pageSize < state.totalCount;
    }
  }
  return false;
}
function parsePaginationState(scheme, body, headers = {}, itemsFetchedSoFar) {
  const { roles, nextLinkResolution } = extractByRole(scheme, body, headers);
  const nextLinkValue = roles.get("nextLink");
  const state = {
    nextPageToken: toStringOrNull(roles.get("nextPageToken") ?? roles.get("nextCursor") ?? null),
    nextLink: typeof nextLinkValue === "string" && nextLinkValue !== "" ? nextLinkValue : null,
    nextLinkValue,
    nextLinkResolution,
    currentPage: toNumberOrNull(roles.get("currentPage") ?? null),
    totalCount: toNumberOrNull(roles.get("totalCount") ?? null),
    totalPages: toNumberOrNull(roles.get("totalPages") ?? null),
    pageSize: toNumberOrNull(roles.get("pageSize") ?? null),
    hasNextPage: false
  };
  state.hasNextPage = deriveHasNextPage(scheme.type, state, itemsFetchedSoFar);
  return state;
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/request-builder.js
function fieldsWithRole(scheme, role, locations = ["queryParameters"]) {
  return locations.flatMap((location) => Object.entries(scheme.request?.[location] ?? {}).filter(([, field]) => field.role === role).map(([name]) => name));
}
function cursorValues(scheme, cursor, pageSize, location) {
  const values = {};
  const withRole = (role) => fieldsWithRole(scheme, role, [location]);
  if (pageSize !== void 0) {
    for (const name of withRole("pageSize")) {
      values[name] = pageSize;
    }
  }
  for (const name of withRole("offset")) {
    values[name] = cursor.offset ?? 0;
  }
  for (const name of withRole("page")) {
    values[name] = cursor.page ?? 1;
  }
  if (cursor.pageToken !== void 0) {
    for (const name of [...withRole("pageToken"), ...withRole("cursor")]) {
      values[name] = cursor.pageToken;
    }
  }
  return values;
}
function buildQuery(scheme, cursor, pageSize) {
  const query = {};
  for (const [name, value] of Object.entries(cursorValues(scheme, cursor, pageSize, "queryParameters"))) {
    query[name] = String(value);
  }
  return query;
}
function buildBody(scheme, cursor, pageSize) {
  const body = {};
  for (const [name, value] of Object.entries(cursorValues(scheme, cursor, pageSize, "bodyFields"))) {
    setNestedField(body, name, value);
  }
  return body;
}
function nextCursor(scheme, cursor, state, itemsReturned) {
  if (!state.hasNextPage) {
    return null;
  }
  const both = ["queryParameters", "bodyFields"];
  switch (scheme.type) {
    case "pageToken":
      return state.nextPageToken !== null ? { pageToken: state.nextPageToken } : null;
    case "nextLink":
    case "rangeWindow":
      return null;
    case "pageNumber":
      if (fieldsWithRole(scheme, "offset", both).length > 0) {
        return { offset: (cursor.offset ?? 0) + itemsReturned };
      }
      if (fieldsWithRole(scheme, "page", both).length > 0) {
        return { page: (cursor.page ?? 1) + 1 };
      }
      return null;
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/pagination/window.js
var WindowReadError = class extends Error {
};
var DAY_MS = 864e5;
var isLeap = (y) => y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
var DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function dayNumber(y, m, d) {
  if (m < 1 || m > 12 || d < 1)
    return void 0;
  const days = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1];
  if (d > days)
    return void 0;
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
var INTEGER = /^-?(0|[1-9][0-9]*)$/;
function parseBound(bound, window) {
  const refuse = () => {
    throw new Error(`bound ${JSON.stringify(bound)} is not in the window format ${window.format}`);
  };
  if (typeof bound !== "string")
    return refuse();
  const { format } = window;
  if (format === "date" || format === "basicDate") {
    const m = format === "date" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(bound) : /^(\d{4})(\d{2})(\d{2})$/.exec(bound);
    if (!m)
      return refuse();
    const day = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    return day === void 0 ? refuse() : day;
  }
  if (format === "dateTime") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(bound);
    if (!m)
      return refuse();
    const day = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    const [h, min, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
    if (day === void 0 || h > 23 || min > 59 || s > 59)
      return refuse();
    return day * 86400 + h * 3600 + min * 60 + s;
  }
  if (!INTEGER.test(bound) || bound === "-0")
    return refuse();
  const n = Number(bound);
  return Number.isSafeInteger(n) ? n : refuse();
}
var pad = (n, width) => String(n).padStart(width, "0");
function formatBound(number, window) {
  const { format } = window;
  if (format === "integer" || format === "unixSeconds")
    return String(number);
  const date = new Date(format === "dateTime" ? number * 1e3 : number * DAY_MS);
  const y = pad(date.getUTCFullYear(), 4);
  const mo = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  if (format === "basicDate")
    return `${y}${mo}${d}`;
  if (format === "date")
    return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`;
}
function windowWidth(first, last, window) {
  return window.bounds === "closed" ? last - first + 1 : last - first;
}
function halves(start, end, window) {
  const first = parseBound(start, window);
  const last = parseBound(end, window);
  const width = windowWidth(first, last, window);
  if (width < 2 * (window.minimumWidth ?? 1))
    return void 0;
  const middle = first + Math.ceil(width / 2);
  const headEnd = window.bounds === "closed" ? middle - 1 : middle;
  return [
    [start, formatBound(headEnd, window)],
    [formatBound(middle, window), end]
  ];
}
function windowFields(scheme) {
  const fields = [];
  for (const location of [
    "queryParameters",
    "bodyFields",
    "headerFields"
  ]) {
    const declared = scheme.request?.[location] ?? {};
    for (const [name, field] of Object.entries(declared)) {
      if (field.role === "windowStart" || field.role === "windowEnd" || field.role === "windowRange")
        fields.push({
          location,
          name,
          role: field.role,
          ...typeof field.template === "string" ? { template: field.template } : {}
        });
    }
  }
  return fields;
}
function windowRequest(scheme, start, end) {
  const values = {
    queryParameters: {},
    bodyFields: {},
    headerFields: {}
  };
  for (const field of windowFields(scheme)) {
    values[field.location][field.name] = field.role === "windowStart" ? start : field.role === "windowEnd" ? end : (field.template ?? "{start}..{end}").replace("{start}", start).replace("{end}", end);
  }
  return values;
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/transport.js
function lowerCaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/pages.js
var DEFAULT_READ_LIMITS = {
  maxRequests: 1e4,
  maxRecords: 5e3,
  timeoutMs: 30 * 60 * 1e3,
  maxRetries: 3
};
var BudgetExhausted = class extends Error {
};
var RetryBeyondDeadline = class extends Error {
};
var PageStatusError = class extends Error {
  status;
  body;
  constructor(message2, status, body) {
    super(message2);
    this.status = status;
    this.body = body;
  }
};
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var Budget = class {
  transport;
  sleep;
  throttling;
  limits;
  deadline;
  requests = 0;
  constructor(transport, limits = {}, sleep = defaultSleep, throttling) {
    this.transport = transport;
    this.sleep = sleep;
    this.throttling = throttling;
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.timeoutMs;
  }
  remainingMs() {
    return Math.max(0, this.deadline - Date.now());
  }
  async send(request) {
    for (let retries = 0; ; retries += 1) {
      if (Date.now() > this.deadline) {
        throw new BudgetExhausted("Read timed out");
      }
      this.requests += 1;
      if (this.requests > this.limits.maxRequests) {
        throw new BudgetExhausted(`Read exceeds ${this.limits.maxRequests} requests; narrow its scope`);
      }
      const raw = await this.transport(request);
      const receivedAt = Date.now();
      const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
      if (retries >= this.limits.maxRetries) {
        return response;
      }
      const throttled = classifyThrottling(this.throttling, {
        status: response.status,
        headers: response.headers,
        body: response.body,
        receivedAt
      });
      if (!throttled || throttled.retryAt === void 0) {
        return response;
      }
      const delay = Math.max(0, throttled.retryAt - Date.now());
      if (Date.now() + delay > this.deadline) {
        throw new RetryBeyondDeadline("API retry delay exceeds the remaining read time");
      }
      await this.sleep(delay);
    }
  }
};
var COMMON_ITEMS_FIELDS2 = ["items", "data", "results", "records", "content"];
function pageItems(body, responseSchema, scheme) {
  let array;
  if (Array.isArray(body)) {
    array = body;
  } else if (isRecord2(body)) {
    const field = locateItemsField(responseSchema, scheme) ?? COMMON_ITEMS_FIELDS2.find((name) => Array.isArray(body[name]));
    array = field === void 0 ? void 0 : body[field];
  }
  if (!Array.isArray(array)) {
    throw new Error("Could not locate the items array in the response");
  }
  return array.filter(isRecord2);
}
function declaredItemsField(walk, scheme) {
  const schemeEnvelope = scheme?.response?.envelope;
  return walk.itemsField ?? (schemeEnvelope === void 0 ? void 0 : typeof schemeEnvelope.itemsField === "string" ? schemeEnvelope.itemsField : "");
}
function itemsAt(body, path, skipNonObjects = false) {
  const array = path === "" ? body : isRecord2(body) ? readNestedField(body, path) : void 0;
  const where = path ? `${path} (the declared envelope.itemsField)` : "the body root";
  if (!Array.isArray(array)) {
    throw new Error(`No items array at ${where}`);
  }
  if (skipNonObjects)
    return array.filter(isRecord2);
  const odd = array.findIndex((item) => !isRecord2(item));
  if (odd !== -1) {
    throw new Error(`Item ${odd} at ${where} is not an object`);
  }
  return array;
}
function bindPath(template, values) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = values[name];
    if (value === void 0 || value === "") {
      throw new Error(`Missing value for ${name}`);
    }
    return encodeURIComponent(value);
  });
}
function withBody(body, cursorFields) {
  const merged = structuredClone(body);
  const flat = [];
  const collect = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      if (isRecord2(value)) {
        collect(value, `${prefix}${key}.`);
      } else {
        flat.push([`${prefix}${key}`, value]);
      }
    }
  };
  collect(cursorFields, "");
  for (const [path, value] of flat) {
    setNestedField(merged, path, value);
  }
  return merged;
}
async function* walkPages(walk) {
  const { document, operation, budget, upstream } = walk;
  const effective = resolveEffectiveScheme(document, operation);
  const scheme = effective?.scheme;
  const responseSchema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  const basePath = upstream.pathname.replace(/\/$/, "");
  if (walk.outcome) {
    walk.outcome.complete = true;
    delete walk.outcome.reason;
  }
  if (scheme?.type === "rangeWindow") {
    yield* walkWindows(walk, scheme, responseSchema);
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  let cursor = {};
  let next;
  let itemsSoFar = 0;
  for (; ; ) {
    let url = next;
    if (!url) {
      url = new URL(upstream.href);
      url.pathname = basePath + walk.path;
      const query = {
        ...walk.query,
        ...scheme ? buildQuery(scheme, cursor, walk.pageSize) : {}
      };
      for (const [key2, value] of Object.entries(query)) {
        url.searchParams.set(key2, value);
      }
    }
    const request = {
      url,
      method: walk.method,
      headers: { accept: "application/json" }
    };
    if (walk.method === "POST") {
      request.headers["content-type"] = "application/json";
      request.body = JSON.stringify(next || !scheme ? walk.body : withBody(walk.body, buildBody(scheme, cursor, walk.pageSize)));
    }
    const key = `${request.method} ${url.href} ${request.body ?? ""}`;
    if (seen.has(key)) {
      throw new Error("Pagination repeated a page; stopping");
    }
    seen.add(key);
    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new PageStatusError(`${request.method} ${url.pathname} responded ${response.status} (failed with status ${response.status})`, response.status, response.body);
    }
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const itemsField = declaredItemsField(walk, scheme);
    const items = itemsField === void 0 ? pageItems(body, responseSchema, scheme) : itemsAt(body, itemsField, walk.skipNonObjects);
    itemsSoFar += items.length;
    yield { url, items, body };
    if (!scheme) {
      return;
    }
    const state = parsePaginationState(scheme, isRecord2(body) ? body : {}, response.headers, itemsSoFar);
    const linkPresent = state.nextLinkValue !== void 0 && state.nextLinkValue !== null && state.nextLinkValue !== "";
    if (!state.hasNextPage && !linkPresent) {
      return;
    }
    if (scheme.type === "nextLink" || linkPresent && state.nextPageToken === null) {
      const link = resolveLink(state.nextLinkValue, {
        requestUrl: url,
        serverUrl: upstream,
        resolution: state.nextLinkResolution
      });
      if (link === null) {
        return;
      }
      next = link;
    } else {
      if (scheme.type === "pageNumber" && items.length === 0) {
        return;
      }
      const following = nextCursor(scheme, cursor, state, items.length);
      if (!following) {
        return;
      }
      cursor = following;
      next = void 0;
    }
  }
}
async function* walkWindows(walk, scheme, responseSchema) {
  const window = scheme.window;
  if (!window) {
    throw new WindowReadError("A rangeWindow scheme needs a window");
  }
  if (!walk.range) {
    throw new WindowReadError(`${walk.path} is read by range windows; pass the range to read`);
  }
  const { start, end } = walk.range;
  if (windowWidth(parseBound(start, window), parseBound(end, window), window) < 1) {
    throw new WindowReadError(`The range ${start}..${end} is empty`);
  }
  const { budget, upstream } = walk;
  const basePath = upstream.pathname.replace(/\/$/, "");
  const yielded = /* @__PURE__ */ new Set();
  const pending = [[start, end]];
  while (pending.length) {
    const [low, high] = pending.shift();
    const values = windowRequest(scheme, low, high);
    const url = new URL(upstream.href);
    url.pathname = basePath + walk.path;
    for (const [key, value] of Object.entries({
      ...walk.query,
      ...values.queryParameters
    })) {
      url.searchParams.set(key, value);
    }
    const request = {
      url,
      method: walk.method,
      headers: { ...values.headerFields, accept: "application/json" }
    };
    if (walk.method === "POST") {
      request.headers["content-type"] = "application/json";
      request.body = JSON.stringify(withBody(walk.body, values.bodyFields));
    }
    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new PageStatusError(`${request.method} ${url.pathname} responded ${response.status} for the window ${low}..${high} (failed with status ${response.status})`, response.status, response.body);
    }
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const itemsField = declaredItemsField(walk, scheme);
    const items = itemsField === void 0 ? pageItems(body, responseSchema, scheme) : itemsAt(body, itemsField, walk.skipNonObjects);
    if (items.length >= window.cap) {
      const split = halves(low, high, window);
      if (!split) {
        throw new WindowReadError(`The window ${low}..${high} answered ${items.length} items, at least the cap of ${window.cap}, and is too narrow to split; the read is not complete`);
      }
      pending.unshift(...split);
      continue;
    }
    const fresh = walk.identity ? items.filter((item) => {
      const id = walk.identity(item);
      if (yielded.has(id))
        return false;
      yielded.add(id);
      return true;
    }) : items;
    yield { url, items: fresh, body };
  }
  if (walk.outcome) {
    walk.outcome.complete = false;
    walk.outcome.reason = "read by range windows: never a complete read (Pagination Schemes 0.5.0 \xA74.6.4)";
  }
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/responses.js
function captureReadResponses(transport, store) {
  if (!store)
    return transport;
  return async (request) => {
    const response = await transport(request);
    await store({
      url: request.url.href,
      method: request.method,
      ...request.body === void 0 ? {} : { requestBody: request.body },
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => [
        "content-type",
        "etag",
        "last-modified",
        "link",
        "retry-after"
      ].includes(name.toLowerCase()))),
      body: response.body,
      receivedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    return response;
  };
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/collections.js
var ProbeDone = class extends Error {
};
function invocations(collection, model, constants, origins) {
  const groups = /* @__PURE__ */ new Map();
  for (const param of collection.contextParams) {
    if (param in constants) {
      continue;
    }
    const provider = model.providers.get(param);
    if (!provider) {
      continue;
    }
    groups.set(provider.collection, [
      ...groups.get(provider.collection) ?? [],
      { param, field: provider.field }
    ]);
  }
  let combos = [{ ...constants }];
  for (const [source, params] of groups) {
    const next = [];
    for (const combo of combos) {
      for (const parent of origins.get(source) ?? []) {
        const values = { ...parent.path, ...combo };
        for (const { param, field } of params) {
          values[param] = asText(parent.value[field]);
        }
        if (params.every(({ param }) => values[param])) {
          next.push(values);
        }
      }
    }
    combos = next;
  }
  const seen = /* @__PURE__ */ new Set();
  return combos.filter((combo) => {
    const key = JSON.stringify(collection.contextParams.map((p) => combo[p] ?? ""));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
async function readCollections(document, options) {
  const doc = resolveRefs(document);
  const model = discoverReadModel(doc, options.legacy);
  applySelection(doc, model, options.selection);
  const constants = options.constants ?? {};
  for (const param of rootParameters(model)) {
    if (!constants[param])
      throw new Error(`Enter a value for ${param}`);
  }
  const budget = options.budget ?? new Budget(captureReadResponses(options.transport, options.storeResponse), options.limits, options.sleep, declaredThrottling(doc));
  const upstream = upstreamOf(doc);
  const collections = [];
  const errors = [];
  const origins = /* @__PURE__ */ new Map();
  const identities = /* @__PURE__ */ new Set();
  let count = 0;
  let exhausted = false;
  let pending = [...model.collections];
  while (pending.length && !exhausted) {
    const waiting = [];
    let progressed = false;
    for (const collection of pending) {
      const sources = collection.contextParams.filter((p) => !(p in constants)).map((p) => model.providers.get(p)?.collection);
      if (sources.some((s) => s === void 0 || s === collection.name)) {
        errors.push(`${collection.name}: its context has no provider`);
        progressed = true;
        continue;
      }
      if (!sources.every((source) => origins.has(source))) {
        waiting.push(collection);
        continue;
      }
      progressed = true;
      const read = [];
      for (const path of invocations(collection, model, constants, origins)) {
        const snapshot = {
          collection,
          pathParams: path,
          items: [],
          complete: false
        };
        collections.push(snapshot);
        try {
          const operation = listOperation(doc, collection.url, collection.method);
          if (!operation && !(options.legacy && doc.components?.["crudResources"] === void 0)) {
            throw new Error(`${collection.url} declares no ${collection.method} operation`);
          }
          const outcome = { complete: true };
          const range = options.ranges?.(collection, path);
          for await (const page of walkPages({
            document: doc,
            operation: operation ?? { responses: {} },
            budget,
            upstream,
            path: bindPath(collection.url, path),
            method: collection.method,
            query: collection.listQuery,
            body: collection.listBody,
            ...collection.itemsField !== void 0 ? { itemsField: collection.itemsField } : {},
            ...range ? { range } : {},
            identity: (value) => asText(value[collection.idField]),
            outcome
          })) {
            if (options.probe)
              throw new ProbeDone();
            for (const value of page.items) {
              const id = asText(value[collection.idField]);
              const key = JSON.stringify([
                collection.resource,
                collection.contextParams.map((p) => path[p]),
                id
              ]);
              if (!id || identities.has(key)) {
                throw new Error("Missing or repeated record identity; pagination may not be forwarded by the proxy");
              }
              if (count >= budget.limits.maxRecords) {
                throw new BudgetExhausted(`Read exceeds ${budget.limits.maxRecords} records; narrow its scope`);
              }
              options.onRecord?.(value, collection, path);
              identities.add(key);
              count += 1;
              snapshot.items.push(value);
            }
          }
          snapshot.complete = outcome.complete;
          if (!outcome.complete && outcome.reason) {
            snapshot.notComplete = outcome.reason;
          }
          read.push(...snapshot.items.map((value) => ({ value, path })));
        } catch (error) {
          if (error instanceof ProbeDone)
            return { collections: [], errors: [] };
          if (options.probe)
            throw error;
          snapshot.error = error instanceof Error ? error.message : String(error);
          errors.push(`${collection.name}: ${snapshot.error}`);
          if (error instanceof BudgetExhausted) {
            exhausted = true;
            break;
          }
        }
      }
      origins.set(collection.name, read);
      if (exhausted)
        break;
    }
    if (!progressed) {
      for (const c of waiting)
        errors.push(`${c.name}: its parent collection could not be read`);
      break;
    }
    pending = waiting;
  }
  if (options.probe)
    throw new Error("No collection available to check");
  return { collections, errors };
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/read/read.js
var resolvedCache = /* @__PURE__ */ new WeakMap();
function resolved(document) {
  let result = resolvedCache.get(document);
  if (!result) {
    result = resolveRefs(document);
    resolvedCache.set(document, result);
  }
  return result;
}
function describePlatform(document) {
  const doc = resolved(document);
  return describeModel(doc, discoverReadModel(doc));
}
var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
function typedValue(value, datatype) {
  if (value === null || value === void 0) {
    return void 0;
  }
  if (datatype === DATATYPES.timestamp) {
    if (typeof value !== "string" || !TIMESTAMP.test(value)) {
      throw new Error("Invalid provider timestamp");
    }
    return Date.parse(value);
  }
  return value;
}
async function readPlatform(document, options) {
  const doc = resolved(document);
  const ontology = options.probe ? { description: "", terms: [] } : deriveOntology(doc);
  const properties = new Map(ontology.terms.filter((t) => t.kind === "property").map((t) => [t.shortname, t.datatype]));
  const records = [];
  const result = await readCollections(doc, {
    ...options,
    onRecord(value, collection, path) {
      const values = {};
      for (const [field, raw] of Object.entries(value)) {
        const shortname = ontologyShortname(field);
        const datatype = properties.get(shortname);
        if (!datatype)
          continue;
        const typed = typedValue(raw, datatype);
        if (typed !== void 0)
          values[shortname] = typed;
      }
      const name = [value["title"], value["summary"], value["name"]].find((v) => typeof v === "string" && v !== "");
      const id = asText(value[collection.idField]);
      records.push({
        resource: ontologyShortname(collection.resource),
        namespace: collection.contextParams.map((p) => path[p] ?? "").join("/"),
        id,
        name: name ?? id,
        values
      });
    }
  });
  if (!records.length && result.errors.length) {
    throw new Error(`Read incomplete: ${result.errors.join("; ")}`);
  }
  return {
    platform: options.platform,
    ontology,
    records,
    errors: result.errors
  };
}

// integrations/pets/node_modules/.pnpm/syncables@0.21.0/node_modules/syncables/build/src/client/client.js
var MAX_TIMER_MS = 2 ** 31 - 1;

// integrations/pets/app/openapi.json
var openapi_default = {
  openapi: "3.0.3",
  info: {
    title: "Pets demo",
    version: "1.0.0",
    description: "A static, read-only demo API published by GitHub Pages from ontola/atomic-plugins (overlays/pets-demo/1.0.0/api/). It needs no account and no credential. GET /pets answers five synthetic pets in one page."
  },
  servers: [
    {
      url: "https://ontola.github.io/atomic-plugins/overlays/pets-demo/1.0.0/api"
    }
  ],
  security: [],
  paths: {
    "/pets": {
      get: {
        "x-pagination": [
          {
            scheme: "nextLink"
          }
        ],
        responses: {
          "200": {
            description: "Pets",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    $ref: "#/components/schemas/Pet"
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    paginationSchemes: {
      nextLink: {
        type: "nextLink",
        response: {
          headers: {
            Link: {
              role: "nextLink"
            }
          }
        }
      }
    },
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: {
            type: "integer"
          },
          name: {
            type: "string"
          },
          species: {
            type: "string"
          },
          age: {
            type: "integer"
          },
          vaccinated: {
            type: "boolean"
          },
          weight: {
            type: "number"
          },
          updated_at: {
            type: "string",
            format: "date-time"
          }
        }
      }
    },
    crudResources: {
      pet: {
        schema: {
          $ref: "#/components/schemas/Pet"
        },
        identity: {
          urlTemplate: "/pets/{pet_id}",
          bindings: {
            pet_id: {
              field: "id"
            }
          }
        },
        collections: {
          pets: {
            urlTemplate: "/pets"
          }
        }
      }
    }
  }
};

// integrations/pets/app/sync.ts
var PLATFORM = "pets";
var PETS_DOCUMENT = openapi_default;
var A = "https://atomicdata.dev";
var PARENT = `${A}/properties/parent`;
var IS_A = `${A}/properties/isA`;
var NAME = `${A}/properties/name`;
var SHORTNAME = `${A}/properties/shortname`;
var DESCRIPTION = `${A}/properties/description`;
var DATATYPE = `${A}/properties/datatype`;
var RECOMMENDS = `${A}/properties/recommends`;
var PROPERTIES = `${A}/properties/properties`;
var PROPERTY_CLASS = `${A}/classes/Property`;
function displayName(shortname) {
  const words = shortname.split("-").join(" ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
var asList = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
async function syncPets(store, transport, { read = readPlatform } = {}) {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error("This app has no table with a row class to sync into.");
  const result = await read(PETS_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport
  });
  const klass = await store.getResource(data.rowClass);
  const ontologySubject = klass.get(PARENT);
  if (typeof ontologySubject !== "string")
    throw new Error("The row class has no parent ontology to add fields to.");
  const properties = await ensureProperties(
    store,
    ontologySubject,
    result.ontology.terms.filter(
      (t) => t.kind === "property" && t.shortname !== "name"
    )
  );
  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [NAME, ...properties.values()];
  const merged = [
    ...recommends,
    ...wanted.filter((s) => !recommends.includes(s))
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== "Pet") {
    await klass.set(RECOMMENDS, merged).set(NAME, "Pet").save();
  }
  const table = await store.getResource(data.table);
  if (table.get(NAME) !== "Pets") await table.set(NAME, "Pets").save();
  const idProperty = properties.get("id");
  if (!idProperty) throw new Error("The Pets API document has no id field.");
  const existing = /* @__PURE__ */ new Map();
  for (const subject of await store.query({
    property: PARENT,
    value: data.table
  })) {
    const row = await store.getResource(subject);
    const id = row.get(idProperty);
    if (id !== void 0 && id !== null) existing.set(String(id), row);
  }
  const summary = {
    total: result.records.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    errors: result.errors
  };
  for (const record of result.records) {
    const propVals = { [NAME]: record.name };
    for (const [shortname, value] of Object.entries(record.values)) {
      const property = properties.get(shortname);
      if (property) propVals[property] = value;
    }
    const row = existing.get(record.id);
    if (!row) {
      await store.newResource({
        parent: data.table,
        isA: [data.rowClass],
        propVals
      });
      summary.added++;
      continue;
    }
    const changed = Object.entries(propVals).filter(
      ([property, value]) => row.get(property) !== value
    );
    if (changed.length === 0) {
      summary.unchanged++;
      continue;
    }
    for (const [property, value] of changed) row.set(property, value);
    await row.save();
    summary.updated++;
  }
  return summary;
}
async function ensureProperties(store, ontologySubject, terms) {
  const ontology = await store.getResource(ontologySubject);
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = /* @__PURE__ */ new Map();
  for (const subject of listed) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
    if (typeof shortname === "string") byShortname.set(shortname, subject);
  }
  const created = [];
  const out = /* @__PURE__ */ new Map();
  for (const term of terms) {
    let subject = byShortname.get(term.shortname);
    if (!subject) {
      const name = displayName(term.shortname);
      const property = await store.newResource({
        parent: ontologySubject,
        isA: [PROPERTY_CLASS],
        propVals: {
          [SHORTNAME]: term.shortname,
          [NAME]: name,
          [DESCRIPTION]: term.description || `${name} of a pet, from the Pets API.`,
          [DATATYPE]: term.datatype
        }
      });
      subject = property.subject;
      created.push(subject);
    }
    out.set(term.shortname, subject);
  }
  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();
  return out;
}

// integrations/pets/app/transport.ts
var RECONNECT_CODES = [
  "unknown_connection",
  "not_delegated",
  "capability_scope",
  "platform_mismatch",
  "credential_refresh_failed"
];
var REFUSAL_CODES = [
  ...RECONNECT_CODES,
  "missing_signature",
  "unsupported_signature_version",
  "invalid_agent",
  "agent_key_mismatch",
  "stale_timestamp",
  "bad_signature",
  "replayed",
  "invalid_capability",
  "capability_expired",
  "capability_too_long",
  "wrong_audience",
  "capability_key_mismatch",
  "not_owner",
  "access_denied"
];
function proxyRefusal(response) {
  const body = response.body;
  const code = typeof body?.error === "string" ? body.error : void 0;
  if (response.status < 400 || !code || !REFUSAL_CODES.includes(code))
    return void 0;
  const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
  return new Error(
    RECONNECT_CODES.includes(code) ? `The integration proxy refused this connection (${code}${detail}). Connect again.` : `The integration proxy refused the request (${code}${detail}).`
  );
}
function relayTransport(proxy, reference, upstream) {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/$/, "");
  return async (request) => {
    const { url } = request;
    if (url.origin !== base.origin || prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      throw new Error(`Refusing a request outside ${upstream}: ${url.href}`);
    const path = `${url.pathname}${url.search}`;
    const response = await proxy.request({
      ...reference,
      path,
      method: request.method,
      ...request.body !== void 0 ? { body: request.body } : {}
    });
    const refused2 = proxyRefusal(response);
    if (refused2) throw refused2;
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? null)
    };
  };
}

// integrations/pets/app/controller.ts
function describe(state) {
  switch (state.kind) {
    case "loading":
      return "Loading\u2026";
    case "no-relay":
      return "This host cannot reach the integration proxy for apps yet.";
    case "disconnected":
      return "Not connected. Connect your Pets account to import your pets.";
    case "connecting":
      return "Waiting for you to confirm the connection\u2026";
    case "ready":
      return "Connected.";
    case "syncing":
      return "Syncing\u2026";
    case "synced": {
      const s = state.summary;
      const errors = s.errors.length ? ` Skipped: ${s.errors.join("; ")}` : "";
      return `Last synced ${state.at.toLocaleTimeString()}: ${s.total} pets (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).${errors}`;
    }
    case "error":
      return `Sync failed: ${state.message}`;
  }
}
var message = (error) => error instanceof Error ? error.message : String(error);
function createController(store, render, sync = syncPets) {
  let state = { kind: "loading" };
  const set = (next) => {
    state = next;
    render(state);
  };
  const upstream = describePlatform(PETS_DOCUMENT).upstream;
  return {
    state: () => state,
    /**
     * Finds this app's connection and starts one sync when there is one.
     * Resolves once the connection is known, not when the sync ends, so the
     * host sees the view as rendered straight away.
     */
    async load() {
      const proxy = store.proxy;
      if (!proxy) {
        set({ kind: "no-relay" });
        return {};
      }
      const [connection] = await proxy.connections({ platform: PLATFORM });
      if (!connection) {
        set({ kind: "disconnected" });
        return {};
      }
      set({ kind: "ready", connection });
      return { syncing: this.sync() };
    },
    async connect() {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: "no-relay" });
      set({ kind: "connecting" });
      try {
        const result = await proxy.connect({ platform: PLATFORM });
        if (result?.status === "connected") await this.load();
        else set({ kind: "disconnected" });
      } catch (error) {
        set({ kind: "error", message: message(error) });
      }
    },
    async sync() {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: "no-relay" });
      if (!("connection" in state) || !state.connection) return;
      if (state.kind === "syncing") return;
      const connection = state.connection;
      set({ kind: "syncing", connection });
      try {
        const summary = await sync(
          store,
          relayTransport(proxy, connection, upstream)
        );
        set({ kind: "synced", connection, at: /* @__PURE__ */ new Date(), summary });
      } catch (error) {
        set({ kind: "error", connection, message: message(error) });
      }
    }
  };
}

// integrations/pets/app/main.ts
async function view({ root, store }) {
  const doc = root.ownerDocument;
  const heading = doc.createElement("h1");
  heading.textContent = "Pets";
  const status = doc.createElement("p");
  status.setAttribute("role", "status");
  const connect = doc.createElement("button");
  connect.type = "button";
  connect.textContent = "Connect Pets";
  const sync = doc.createElement("button");
  sync.type = "button";
  sync.textContent = "Sync now";
  root.style.fontFamily = "system-ui, sans-serif";
  root.style.padding = "1rem";
  root.replaceChildren(heading, status, connect, sync);
  const render = (state) => {
    status.textContent = describe(state);
    connect.hidden = !(state.kind === "disconnected" || state.kind === "error" && !state.connection);
    sync.hidden = !(state.kind === "ready" || state.kind === "synced" || state.kind === "syncing" || state.kind === "error" && !!state.connection);
    sync.disabled = state.kind === "syncing";
  };
  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener("click", () => void controller.connect());
  sync.addEventListener("click", () => void controller.sync());
  await controller.load().catch((error) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
export {
  view
};
