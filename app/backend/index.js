require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('redis');
const client = require('prom-client');
const {
  CACHE_KEYS,
  normalizeClassSlug,
  fetchClasses,
  classExists,
  fetchProducts,
  fetchProductDetail,
} = require('./lib/catalog');

const COMPARE_PRODUCT_COUNT = 3;

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'jeanos_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'jeanos_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const comparatorRequestsTotal = new client.Counter({
  name: 'jeanos_comparator_requests_total',
  help: 'Total comparator API requests',
  labelNames: ['status_code', 'source'],
  registers: [register],
});

const comparatorDuration = new client.Histogram({
  name: 'jeanos_comparator_duration_seconds',
  help: 'Comparator API duration in seconds',
  labelNames: ['status_code', 'source'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const cacheHitsTotal = new client.Counter({
  name: 'jeanos_cache_hits_total',
  help: 'Cache hits served from Redis',
  labelNames: ['route', 'source'],
  registers: [register],
});

const cacheMissesTotal = new client.Counter({
  name: 'jeanos_cache_misses_total',
  help: 'Cache misses loaded from PostgreSQL',
  labelNames: ['route', 'source'],
  registers: [register],
});

function routeLabel(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    return `${base}${req.route.path}`;
  }
  return req.path;
}

function recordHttpMetrics(req, res, startNs) {
  const route = routeLabel(req);
  const labels = {
    method: req.method,
    route,
    status_code: String(res.statusCode),
  };
  httpRequestsTotal.inc(labels);
  const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
  httpRequestDuration.observe(labels, durationSec);
}

function recordCacheHit(route, source = 'redis') {
  cacheHitsTotal.inc({ route, source });
}

function recordCacheMiss(route, source = 'postgresql') {
  cacheMissesTotal.inc({ route, source });
}

function recordComparatorMetrics(statusCode, source, durationSec) {
  const labels = {
    status_code: String(statusCode),
    source: source || 'none',
  };
  comparatorRequestsTotal.inc(labels);
  comparatorDuration.observe(labels, durationSec);
}

function mapCompareProduct(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    marca: row.marca,
    modelo: row.modelo,
    precio: Number(row.precio),
  };
}

function buildComparePayload(productRows, specRows, requestOrder) {
  const byId = new Map(productRows.map((r) => [r.id, r]));
  const products = requestOrder.map((id) => mapCompareProduct(byId.get(id)));

  const classRow = productRows[0];
  const classInfo = {
    id: classRow.clase_id,
    slug: classRow.clase_slug,
    nombre: classRow.clase_nombre,
  };

  const specsByKey = new Map();

  for (const row of specRows) {
    if (!specsByKey.has(row.spec_key)) {
      specsByKey.set(row.spec_key, {
        key: row.spec_key,
        label: row.label,
        unit: row.unit,
        sort_order: row.sort_order,
        values: [],
      });
    }

    const entry = specsByKey.get(row.spec_key);
    if (row.producto_id != null) {
      entry.values.push({
        product_id: row.producto_id,
        value: specValueFromParts(
          row.data_type,
          row.valor_texto,
          row.valor_numero,
          row.valor_booleano,
        ),
      });
    }
  }

  const specs = [...specsByKey.values()]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(({ sort_order, ...rest }) => rest);

  const prices = products.map((p) => p.precio);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const cheapest = products.find((p) => p.precio === minPrice) ?? products[0];

  return {
    class: classInfo,
    products,
    specs,
    price_difference: maxPrice - minPrice,
    cheapest_product: {
      id: cheapest.id,
      nombre: cheapest.nombre,
      precio: cheapest.precio,
    },
  };
}

function specValueFromParts(dataType, valorTexto, valorNumero, valorBooleano) {
  if (dataType === 'boolean') {
    return valorBooleano;
  }
  if (dataType === 'number') {
    return valorNumero != null ? Number(valorNumero) : null;
  }
  return valorTexto;
}

/** Lectura Redis tolerante a fallos: null = miss → PostgreSQL */
async function redisGet(key) {
  try {
    if (!redisClient.isReady) {
      return null;
    }
    return await redisClient.get(key);
  } catch (err) {
    console.error('Redis GET falló:', err.message);
    return null;
  }
}

async function redisTtl(key) {
  try {
    if (!redisClient.isReady) {
      return null;
    }
    const ttl = await redisClient.ttl(key);
    return ttl >= 0 ? ttl : null;
  } catch (err) {
    console.error('Redis TTL falló:', err.message);
    return null;
  }
}

/** Escritura Redis best-effort; no bloquea la respuesta */
async function redisSetEx(key, payload) {
  try {
    if (!redisClient.isReady) {
      return;
    }
    await redisClient.setEx(key, CACHE_TTL_SECONDS, payload);
  } catch (err) {
    console.error('Redis SET falló:', err.message);
  }
}

async function respondCached(route, res, cacheKey, loadFromDb) {
  const cached = await redisGet(cacheKey);

  if (cached) {
    recordCacheHit(route, 'redis');
    const ttl = await redisTtl(cacheKey);
    return res.json({
      source: 'redis',
      ttl_seconds: ttl ?? CACHE_TTL_SECONDS,
      data: JSON.parse(cached),
    });
  }

  recordCacheMiss(route, 'postgresql');
  const data = await loadFromDb();
  await redisSetEx(cacheKey, JSON.stringify(data));

  return res.json({
    source: 'postgresql',
    ttl_seconds: CACHE_TTL_SECONDS,
    data,
  });
}

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const startNs = process.hrtime.bigint();
  res.on('finish', () => {
    recordHttpMetrics(req, res, startNs);
  });
  next();
});

const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'jeanosdb',
  user: process.env.DB_USER || 'jeanosadmin',
  password: process.env.DB_PASSWORD || 'password',
});

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err.message);
});

app.get('/', (req, res) => {
  res.json({
    app: 'jeanOS Shop Backend',
    status: 'running',
    stack: ['Node.js', 'PostgreSQL', 'Redis'],
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'jeanos-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    const redisOk = redisClient.isReady;
    if (!redisOk) {
      return res.status(503).json({
        status: 'not_ready',
        postgres: 'ok',
        redis: 'disconnected',
        error: 'Redis no está conectado',
      });
    }

    res.status(200).json({
      status: 'ready',
      postgres: 'ok',
      redis: 'ok',
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      error: err.message,
    });
  }
});

app.get('/api/classes', async (req, res) => {
  const route = '/api/classes';

  try {
    await respondCached(route, res, CACHE_KEYS.classesAll, () => fetchClasses(pool));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  const route = '/api/products';

  try {
    const hasClassParam =
      req.query.class != null && String(req.query.class).trim() !== '';

    if (hasClassParam) {
      const classSlug = normalizeClassSlug(req.query.class);

      if (classSlug === false) {
        return res.status(400).json({
          error: 'Parámetro class inválido',
          code: 'INVALID_CLASS_PARAM',
          details: { class: String(req.query.class) },
        });
      }

      const exists = await classExists(pool, classSlug);
      if (!exists) {
        return res.status(404).json({
          error: 'Clase no encontrada',
          code: 'CLASS_NOT_FOUND',
          details: { class: classSlug },
        });
      }

      const cacheKey = CACHE_KEYS.productsByClass(classSlug);
      await respondCached(route, res, cacheKey, () => fetchProducts(pool, classSlug));
      return;
    }

    await respondCached(route, res, CACHE_KEYS.productsAll, () => fetchProducts(pool));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const route = '/api/products/:id';

  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: 'ID inválido',
        code: 'INVALID_PRODUCT_ID',
      });
    }

    const cacheKey = CACHE_KEYS.productDetails(id);
    const cached = await redisGet(cacheKey);

    if (cached) {
      recordCacheHit(route, 'redis');
      const ttl = await redisTtl(cacheKey);
      return res.json({
        source: 'redis',
        ttl_seconds: ttl ?? CACHE_TTL_SECONDS,
        data: JSON.parse(cached),
      });
    }

    recordCacheMiss(route, 'postgresql');

    const data = await fetchProductDetail(pool, id);
    if (!data) {
      return res.status(404).json({
        error: 'Producto no encontrado',
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    await redisSetEx(cacheKey, JSON.stringify(data));

    res.json({
      source: 'postgresql',
      ttl_seconds: CACHE_TTL_SECONDS,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compare', async (req, res) => {
  const route = '/api/compare';
  const compareStartNs = process.hrtime.bigint();

  const finishCompare = (statusCode, source) => {
    const durationSec = Number(process.hrtime.bigint() - compareStartNs) / 1e9;
    recordComparatorMetrics(statusCode, source, durationSec);
  };

  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length !== COMPARE_PRODUCT_COUNT) {
      finishCompare(400, 'none');
      return res.status(400).json({
        error: `Debes enviar exactamente ${COMPARE_PRODUCT_COUNT} IDs en el campo ids`,
        code: 'COMPARE_INVALID_COUNT',
        details: {
          expected_count: COMPARE_PRODUCT_COUNT,
          received_count: Array.isArray(ids) ? ids.length : 0,
        },
        example: { ids: [1, 2, 3] },
      });
    }

    const numericIds = ids.map((id) => Number(id));
    const allValid = numericIds.every(
      (id) => Number.isInteger(id) && id > 0,
    );

    if (!allValid) {
      finishCompare(400, 'none');
      return res.status(400).json({
        error: `Los IDs deben ser ${COMPARE_PRODUCT_COUNT} enteros positivos`,
        code: 'COMPARE_INVALID_IDS',
        details: { ids },
      });
    }

    if (new Set(numericIds).size !== COMPARE_PRODUCT_COUNT) {
      finishCompare(400, 'none');
      return res.status(400).json({
        error: `Los IDs deben ser ${COMPARE_PRODUCT_COUNT} enteros positivos distintos`,
        code: 'COMPARE_INVALID_IDS',
        details: { ids },
      });
    }

    const orderedIds = [...numericIds].sort((a, b) => a - b);
    const requestOrder = numericIds;
    const cacheKey = CACHE_KEYS.compare(...orderedIds);
    const cached = await redisGet(cacheKey);

    if (cached) {
      recordCacheHit(route, 'redis');
      finishCompare(200, 'redis');
      const ttl = await redisTtl(cacheKey);
      return res.json({
        source: 'redis',
        ttl_seconds: ttl ?? CACHE_TTL_SECONDS,
        data: JSON.parse(cached),
      });
    }

    recordCacheMiss(route, 'postgresql');

    const productResult = await pool.query(
      `
      SELECT
        p.id,
        p.nombre,
        p.marca,
        p.modelo,
        p.precio,
        p.clase_id,
        cp.slug AS clase_slug,
        cp.nombre AS clase_nombre
      FROM productos p
      INNER JOIN clases_producto cp ON cp.id = p.clase_id
      WHERE p.id = ANY($1::int[]);
      `,
      [orderedIds],
    );

    const foundIds = productResult.rows.map((r) => r.id);
    const missingIds = orderedIds.filter((pid) => !foundIds.includes(pid));

    if (missingIds.length > 0) {
      finishCompare(404, 'none');
      return res.status(404).json({
        error: 'Uno o más productos no existen',
        code: 'COMPARE_PRODUCT_NOT_FOUND',
        details: {
          requested_ids: orderedIds,
          missing_ids: missingIds,
        },
      });
    }

    const classIds = [...new Set(productResult.rows.map((r) => r.clase_id))];

    if (classIds.length > 1) {
      finishCompare(400, 'none');
      return res.status(400).json({
        error: 'Solo puedes comparar productos de la misma clase',
        code: 'COMPARE_CLASS_MISMATCH',
        details: {
          requested_ids: orderedIds,
          classes: productResult.rows.map((r) => ({
            product_id: r.id,
            slug: r.clase_slug,
            nombre: r.clase_nombre,
          })),
        },
      });
    }

    const specResult = await pool.query(
      `
      SELECT
        sd.spec_key,
        sd.label,
        sd.unit,
        sd.data_type,
        sd.sort_order,
        ps.producto_id,
        ps.valor_texto,
        ps.valor_numero,
        ps.valor_booleano
      FROM spec_definitions sd
      LEFT JOIN producto_specs ps
        ON ps.spec_definition_id = sd.id
        AND ps.producto_id = ANY($1::int[])
      WHERE sd.clase_id = $2
      ORDER BY sd.sort_order;
      `,
      [orderedIds, classIds[0]],
    );

    const comparison = buildComparePayload(
      productResult.rows,
      specResult.rows,
      requestOrder,
    );

    await redisSetEx(cacheKey, JSON.stringify(comparison));

    finishCompare(200, 'postgresql');
    res.json({
      source: 'postgresql',
      ttl_seconds: CACHE_TTL_SECONDS,
      data: comparison,
    });
  } catch (err) {
    finishCompare(500, 'none');
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL conectado');

    try {
      await redisClient.connect();
      console.log('Redis conectado');
    } catch (err) {
      console.error('Redis no disponible al arranque (API usará solo PostgreSQL):', err.message);
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend jeanOS Shop escuchando en puerto ${PORT}`);
    });
  } catch (err) {
    console.error('Error al arrancar backend:', err.message);
    process.exit(1);
  }
}

start();
