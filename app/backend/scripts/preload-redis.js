/**
 * Precarga catálogo PostgreSQL → Redis (init container).
 * Keys idénticas a index.js vía lib/catalog.js (CACHE_KEYS).
 */
require('dotenv').config();

const { Pool } = require('pg');
const { createClient } = require('redis');
const {
  CACHE_KEYS,
  fetchClasses,
  fetchClassSlugs,
  fetchProducts,
  fetchProductIds,
  fetchProductDetail,
} = require('../lib/catalog');

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
  console.error('[preload] Redis error:', err.message);
});

async function shutdown(exitCode) {
  try {
    if (redisClient.isReady) await redisClient.quit();
  } catch (_) {
    /* ignore */
  }
  try {
    await pool.end();
  } catch (_) {
    /* ignore */
  }
  process.exit(exitCode);
}

function fail(message) {
  console.error(`[preload] ERROR: ${message}`);
  return shutdown(1);
}

async function connectPostgreSQL() {
  console.log('[preload] Conectando PostgreSQL...');
  try {
    await pool.query('SELECT 1');
    console.log('[preload] PostgreSQL conectado');
  } catch (err) {
    await fail(`PostgreSQL no disponible: ${err.message}`);
  }
}

async function connectRedis() {
  console.log('[preload] Conectando Redis...');
  try {
    await redisClient.connect();
    console.log('[preload] Redis conectado');
  } catch (err) {
    await fail(`Redis no disponible: ${err.message}`);
  }
}

function assertProductShape(product, context) {
  const required = ['id', 'nombre', 'marca', 'modelo', 'precio', 'clase'];
  for (const field of required) {
    if (product[field] == null) {
      throw new Error(`${context}: falta campo "${field}" en producto id=${product.id}`);
    }
  }
  if (!product.clase.id || !product.clase.slug || !product.clase.nombre) {
    throw new Error(`${context}: objeto clase incompleto en producto id=${product.id}`);
  }
}

function validateCatalogData(classes, allProducts, slugs, detailsById) {
  if (classes.length === 0) {
    throw new Error('no hay filas en clases_producto');
  }

  if (allProducts.length === 0) {
    throw new Error('no hay filas en productos');
  }

  for (const product of allProducts) {
    assertProductShape(product, 'products:all');
  }

  for (const slug of slugs) {
    const count = allProducts.filter((p) => p.clase.slug === slug).length;
    if (count === 0) {
      throw new Error(`la clase "${slug}" no tiene productos`);
    }
  }

  for (const [id, detail] of detailsById) {
    if (!detail) {
      throw new Error(`detalle no encontrado para producto id=${id}`);
    }
    assertProductShape(detail, `product:${id}:details`);
    if (!Array.isArray(detail.specs) || detail.specs.length === 0) {
      throw new Error(`producto id=${id} sin specs en product:${id}:details`);
    }
  }
}

async function writeCache(key, payload) {
  await redisClient.setEx(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
}

async function main() {
  const pgHost = process.env.DB_HOST || 'localhost';
  const pgPort = process.env.DB_PORT || '5432';
  const pgDb = process.env.DB_NAME || 'jeanosdb';
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = process.env.REDIS_PORT || '6379';

  console.log('[preload] Iniciando precarga Redis');
  console.log(`[preload] PostgreSQL → ${pgHost}:${pgPort}/${pgDb}`);
  console.log(`[preload] Redis → ${redisHost}:${redisPort}`);
  console.log(`[preload] TTL → ${CACHE_TTL_SECONDS}s`);

  try {
    await connectPostgreSQL();

    const classes = await fetchClasses(pool);
    const productIds = await fetchProductIds(pool);
    const slugs = await fetchClassSlugs(pool);
    const allProducts = await fetchProducts(pool);

    console.log(`[preload] Datos leídos de PostgreSQL: ${classes.length} clases, ${allProducts.length} productos`);

    const detailsById = new Map();
    for (const id of productIds) {
      detailsById.set(id, await fetchProductDetail(pool, id));
    }

    try {
      validateCatalogData(classes, allProducts, slugs, detailsById);
    } catch (err) {
      await fail(`datos mínimos incompletos: ${err.message}`);
      return;
    }

    await connectRedis();

    const mainKeys = [];
    let detailsLoaded = 0;

    await writeCache(CACHE_KEYS.classesAll, classes);
    mainKeys.push(CACHE_KEYS.classesAll);
    console.log(`[preload] Key creada: ${CACHE_KEYS.classesAll}`);

    await writeCache(CACHE_KEYS.productsAll, allProducts);
    mainKeys.push(CACHE_KEYS.productsAll);
    console.log(`[preload] Key creada: ${CACHE_KEYS.productsAll}`);

    for (const slug of slugs) {
      const byClass = await fetchProducts(pool, slug);
      const key = CACHE_KEYS.productsByClass(slug);
      await writeCache(key, byClass);
      mainKeys.push(key);
      console.log(`[preload] Key creada: ${key} (${byClass.length} productos)`);
    }

    for (const id of productIds) {
      const detail = detailsById.get(id);
      const key = CACHE_KEYS.productDetails(id);
      await writeCache(key, detail);
      detailsLoaded += 1;
    }
    mainKeys.push(`product:{id}:details (${detailsLoaded} keys)`);

    const ttlSample = await redisClient.ttl(CACHE_KEYS.productsAll);

    console.log('[preload] --- Resumen ---');
    console.log(`[preload] Clases cargadas: ${classes.length}`);
    console.log(`[preload] Productos cargados (products:all): ${allProducts.length}`);
    console.log(`[preload] Detalles cargados (product:{id}:details): ${detailsLoaded}`);
    console.log(`[preload] Keys por clase (products:class:{{slug}}): ${slugs.length}`);
    console.log('[preload] Keys principales:');
    for (const k of mainKeys) {
      console.log(`[preload]   - ${k}`);
    }
    console.log(`[preload] TTL verificado en ${CACHE_KEYS.productsAll}: ${ttlSample}s`);
    console.log('[preload] Precarga completada correctamente');

    await shutdown(0);
  } catch (err) {
    console.error('[preload] Fallo inesperado:', err.message);
    await shutdown(1);
  }
}

main();
