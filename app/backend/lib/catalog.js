/**
 * Consultas y mapeo del catálogo — compartido por index.js y preload-redis.js.
 */

const CLASS_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const CACHE_KEYS = {
  classesAll: 'classes:all',
  productsAll: 'products:all',
  productsByClass: (slug) => `products:class:${slug}`,
  productDetails: (id) => `product:${id}:details`,
  compare: (...ids) => `compare:${[...ids].sort((a, b) => a - b).join(':')}`,
};

function normalizeClassSlug(raw) {
  if (raw == null || String(raw).trim() === '') {
    return null;
  }
  const slug = String(raw).trim().toLowerCase();
  if (!CLASS_SLUG_RE.test(slug)) {
    return false;
  }
  return slug;
}

function mapClaseSummary(row) {
  return {
    id: row.clase_id,
    slug: row.clase_slug,
    nombre: row.clase_nombre,
  };
}

function mapClaseFull(row) {
  return {
    id: row.clase_id,
    slug: row.clase_slug,
    nombre: row.clase_nombre,
    descripcion: row.clase_descripcion ?? null,
  };
}

function mapProductListItem(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    marca: row.marca,
    modelo: row.modelo,
    precio: row.precio,
    clase: mapClaseSummary(row),
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

function mapSpecItem(row) {
  return {
    key: row.spec_key,
    label: row.label,
    unit: row.unit,
    value: specValueFromParts(
      row.data_type,
      row.valor_texto,
      row.valor_numero,
      row.valor_booleano,
    ),
    sort_order: row.sort_order,
  };
}

function mapProductDetail(row, specRows) {
  return {
    id: row.id,
    nombre: row.nombre,
    marca: row.marca,
    modelo: row.modelo,
    precio: row.precio,
    clase: mapClaseFull(row),
    specs: specRows.map(mapSpecItem),
  };
}

async function fetchClasses(pool) {
  const result = await pool.query(`
    SELECT id, slug, nombre, descripcion
    FROM clases_producto
    ORDER BY id;
  `);
  return result.rows;
}

async function fetchClassSlugs(pool) {
  const result = await pool.query(`
    SELECT slug FROM clases_producto ORDER BY id;
  `);
  return result.rows.map((r) => r.slug);
}

async function classExists(pool, slug) {
  const result = await pool.query(
    'SELECT id FROM clases_producto WHERE slug = $1',
    [slug],
  );
  return result.rows.length > 0;
}

async function fetchProducts(pool, classSlug = null) {
  const params = [];
  let whereClause = '';

  if (classSlug) {
    whereClause = 'WHERE cp.slug = $1';
    params.push(classSlug);
  }

  const result = await pool.query(
    `
    SELECT
      p.id,
      p.nombre,
      p.marca,
      p.modelo,
      p.precio,
      cp.id AS clase_id,
      cp.slug AS clase_slug,
      cp.nombre AS clase_nombre
    FROM productos p
    INNER JOIN clases_producto cp ON cp.id = p.clase_id
    ${whereClause}
    ORDER BY p.id;
    `,
    params,
  );

  return result.rows.map(mapProductListItem);
}

async function fetchProductIds(pool) {
  const result = await pool.query('SELECT id FROM productos ORDER BY id');
  return result.rows.map((r) => r.id);
}

async function fetchProductDetail(pool, id) {
  const productResult = await pool.query(
    `
    SELECT
      p.id,
      p.nombre,
      p.marca,
      p.modelo,
      p.precio,
      cp.id AS clase_id,
      cp.slug AS clase_slug,
      cp.nombre AS clase_nombre,
      cp.descripcion AS clase_descripcion
    FROM productos p
    INNER JOIN clases_producto cp ON cp.id = p.clase_id
    WHERE p.id = $1;
    `,
    [id],
  );

  if (productResult.rows.length === 0) {
    return null;
  }

  const specResult = await pool.query(
    `
    SELECT
      sd.spec_key,
      sd.label,
      sd.unit,
      sd.data_type,
      sd.sort_order,
      ps.valor_texto,
      ps.valor_numero,
      ps.valor_booleano
    FROM producto_specs ps
    INNER JOIN spec_definitions sd ON sd.id = ps.spec_definition_id
    WHERE ps.producto_id = $1
    ORDER BY sd.sort_order;
    `,
    [id],
  );

  return mapProductDetail(productResult.rows[0], specResult.rows);
}

module.exports = {
  CACHE_KEYS,
  CLASS_SLUG_RE,
  normalizeClassSlug,
  fetchClasses,
  fetchClassSlugs,
  classExists,
  fetchProducts,
  fetchProductIds,
  fetchProductDetail,
};
