import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ProductService,
  CompareApiResponse,
  CompareSpecRow,
  ProductoDetalle,
} from '../../services/product.service';

@Component({
  selector: 'app-comparador',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="comparador">
      <div class="section-header">
        <div class="section-label">COMPARADOR DE HARDWARE</div>
        <button type="button" class="clear-btn" (click)="onClear()" *ngIf="selectedIds.length > 0">
          Limpiar selección
        </button>
      </div>

      <!-- 0 productos -->
      <div class="empty" *ngIf="selectedIds.length === 0 && !loading && !result">
        <div class="empty-icon">⬡</div>
        <div class="empty-title">Sin productos seleccionados</div>
        <div class="empty-sub">
          Ve al catálogo y selecciona <strong>2 productos de la misma clase</strong> para comparar especificaciones.
        </div>
      </div>

      <!-- Más de 2 -->
      <div class="error" *ngIf="selectedIds.length > 2 && !loading">
        ⚠ Solo puedes comparar exactamente 2 productos. Tienes {{ selectedIds.length }} seleccionados; usa «Limpiar selección».
        <button type="button" (click)="onClear()">Limpiar</button>
      </div>

      <!-- 1 producto -->
      <div class="partial" *ngIf="selectedIds.length === 1 && !loading && !error">
        <div class="partial-label">1/2 productos · falta uno de la misma clase</div>
        <div class="partial-card" *ngIf="partialProduct; else partialLoading">
          <span class="partial-class">{{ partialProduct.clase.nombre }}</span>
          <div class="partial-name">{{ partialProduct.nombre }}</div>
          <div class="partial-meta">{{ partialProduct.marca }} · {{ partialProduct.modelo }}</div>
          <div class="partial-price">\${{ formatPrice(partialProduct.precio) }}</div>
        </div>
        <ng-template #partialLoading>
          <div class="loading inline-loading">
            <div class="spinner"></div>
            Cargando producto...
          </div>
        </ng-template>
        <p class="partial-hint">Vuelve al catálogo y elige otro producto de <strong>{{ partialProduct?.clase?.nombre ?? 'la misma clase' }}</strong>.</p>
      </div>

      <!-- Loading -->
      <div class="loading" *ngIf="loading">
        <div class="spinner"></div>
        <ng-container [ngSwitch]="loadingMode">
          <span *ngSwitchCase="'partial'">Cargando producto seleccionado...</span>
          <span *ngSwitchDefault>
            Comparando especificaciones vía {{ lastSource === 'redis' ? 'Redis cache' : 'PostgreSQL' }}...
          </span>
        </ng-container>
      </div>

      <!-- Error API -->
      <div class="error" *ngIf="error && selectedIds.length <= 2 && !loading">
        ⚠ {{ error }}
        <button type="button" (click)="retryCompare()" *ngIf="selectedIds.length === 2">Reintentar</button>
      </div>

      <!-- Resultado -->
      <div class="result" *ngIf="result && !loading && selectedIds.length === 2">
        <h2 class="compare-title">
          Comparación · {{ result.data.class.nombre }}
          <span class="compare-slug">{{ result.data.class.slug }}</span>
        </h2>

        <div class="result-meta">
          <div class="source-badge" [class.redis]="lastSource === 'redis'" [class.pg]="lastSource === 'postgresql'">
            <span class="source-dot"></span>
            {{ lastSource === 'redis' ? '⚡ Redis cache' : '🗄 PostgreSQL' }}
            <span class="ttl">· TTL {{ result.ttl_seconds }}s</span>
          </div>
          <div class="latency" *ngIf="latencyMs !== null">
            Latencia: <strong>{{ latencyMs }}ms</strong>
          </div>
        </div>

        <div class="winner-banner" *ngIf="result.data.cheapest_product as cheapest">
          <div class="winner-label">MÁS BARATO</div>
          <div class="winner-name">{{ cheapest.nombre }}</div>
          <div class="winner-price">\${{ formatPrice(cheapest.precio) }}</div>
        </div>

        <div class="products-grid">
          <div
            class="product-card"
            *ngFor="let p of result.data.products"
            [class.cheapest]="p.id === result.data.cheapest_product.id"
          >
            <div class="product-rank" *ngIf="p.id === result.data.cheapest_product.id">MEJOR PRECIO</div>
            <div class="product-id">ID · {{ p.id }}</div>
            <div class="product-name">{{ p.nombre }}</div>
            <div class="product-meta">{{ p.marca }} · {{ p.modelo }}</div>
            <div class="product-price">\${{ formatPrice(p.precio) }}</div>
          </div>
        </div>

        <div class="diff-row">
          <span class="diff-label">Diferencia de precio:</span>
          <span class="diff-value">\${{ formatPrice(result.data.price_difference) }}</span>
        </div>

        <div class="specs-section" *ngIf="compareSpecs.length > 0">
          <div class="specs-title">Especificaciones</div>
          <div class="specs-table-wrap">
            <table class="specs-table">
              <thead>
                <tr>
                  <th>Especificación</th>
                  <th>{{ productColumnLabel(0) }}</th>
                  <th>{{ productColumnLabel(1) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let row of compareSpecs; trackBy: trackSpecRow">
                  <td class="spec-name-cell">
                    <span class="spec-label">{{ row.label }}</span>
                    <span class="spec-unit" *ngIf="row.unit">{{ row.unit }}</span>
                  </td>
                  <td [class.spec-diff]="!specValuesEqual(row)">{{ formatSpecCell(row, 0) }}</td>
                  <td [class.spec-diff]="!specValuesEqual(row)">{{ formatSpecCell(row, 1) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <button type="button" class="compare-btn secondary" (click)="resetResult()">
          ← Actualizar comparación
        </button>
      </div>
    </div>
  `,
  styles: [`
    .comparador {
      --accent: #84cc16;
      --accent2: #22d3ee;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .section-label {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      color: #5a5c72;
    }

    .clear-btn {
      background: none;
      border: 1px solid #1c1e2a;
      color: #5a5c72;
      font-family: inherit;
      font-size: 0.7rem;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .clear-btn:hover { border-color: #f87171; color: #f87171; }

    .empty {
      text-align: center;
      padding: 80px 24px;
    }

    .empty-icon {
      font-size: 3rem;
      color: #1c1e2a;
      margin-bottom: 16px;
    }

    .empty-title {
      font-size: 1rem;
      font-weight: 700;
      color: #5a5c72;
      margin-bottom: 8px;
    }

    .empty-sub {
      font-size: 0.78rem;
      color: #3a3c52;
      line-height: 1.5;
    }

    .empty-sub strong { color: #5a5c72; }

    .partial { margin-bottom: 20px; }

    .partial-label {
      font-size: 0.72rem;
      color: #5a5c72;
      margin-bottom: 12px;
      letter-spacing: 0.05em;
    }

    .partial-card {
      background: #0f1017;
      border: 1px solid #1c1e2a;
      border-radius: 10px;
      padding: 18px;
      margin-bottom: 12px;
      max-width: 360px;
    }

    .partial-class {
      font-size: 0.58rem;
      letter-spacing: 0.12em;
      color: var(--accent2);
      text-transform: uppercase;
    }

    .partial-name {
      font-size: 0.95rem;
      font-weight: 700;
      margin: 8px 0 4px;
    }

    .partial-meta {
      font-size: 0.68rem;
      color: #5a5c72;
      margin-bottom: 10px;
    }

    .partial-price {
      font-size: 1.1rem;
      color: var(--accent);
      font-weight: 700;
    }

    .partial-hint {
      font-size: 0.72rem;
      color: #5a5c72;
    }

    .partial-hint strong { color: #e8eaf2; }

    .inline-loading { padding: 12px 0; }

    .loading {
      display: flex;
      align-items: center;
      gap: 12px;
      color: #5a5c72;
      font-size: 0.8rem;
      padding: 40px 0;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid #1c1e2a;
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .error {
      color: #f87171;
      font-size: 0.8rem;
      padding: 20px;
      background: rgba(248,113,113,0.05);
      border: 1px solid rgba(248,113,113,0.2);
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .error button {
      background: none;
      border: 1px solid rgba(248,113,113,0.4);
      color: #f87171;
      font-family: inherit;
      font-size: 0.72rem;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }

    .compare-title {
      font-size: 1rem;
      font-weight: 700;
      margin: 0 0 16px;
      letter-spacing: -0.02em;
    }

    .compare-slug {
      font-size: 0.65rem;
      color: #5a5c72;
      font-weight: 400;
      letter-spacing: 0.12em;
      margin-left: 8px;
      text-transform: uppercase;
    }

    .result-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .source-badge {
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 100px;
      border: 1px solid #1c1e2a;
    }

    .source-badge.redis { color: #22d3ee; border-color: rgba(34,211,238,0.25); background: rgba(34,211,238,0.05); }
    .source-badge.pg { color: #a78bfa; border-color: rgba(167,139,250,0.25); background: rgba(167,139,250,0.05); }

    .source-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s infinite;
    }

    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

    .ttl { opacity: 0.6; }

    .latency {
      font-size: 0.72rem;
      color: #5a5c72;
    }

    .latency strong { color: var(--accent); }

    .winner-banner {
      background: rgba(132,204,22,0.06);
      border: 1px solid rgba(132,204,22,0.25);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }

    .winner-label {
      font-size: 0.6rem;
      letter-spacing: 0.2em;
      color: var(--accent);
      white-space: nowrap;
    }

    .winner-name {
      flex: 1;
      font-size: 1rem;
      font-weight: 700;
      min-width: 120px;
    }

    .winner-price {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: -0.03em;
    }

    .products-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }

    @media (max-width: 640px) {
      .products-grid { grid-template-columns: 1fr; }
    }

    .product-card {
      background: #0f1017;
      border: 1px solid #1c1e2a;
      border-radius: 10px;
      padding: 18px;
    }

    .product-card.cheapest {
      border-color: rgba(132,204,22,0.4);
    }

    .product-rank {
      font-size: 0.58rem;
      letter-spacing: 0.15em;
      color: var(--accent);
      margin-bottom: 10px;
    }

    .product-id {
      font-size: 0.6rem;
      color: #5a5c72;
      letter-spacing: 0.15em;
      margin-bottom: 6px;
    }

    .product-name {
      font-size: 0.85rem;
      font-weight: 700;
      margin-bottom: 4px;
      line-height: 1.3;
    }

    .product-meta {
      font-size: 0.68rem;
      color: #5a5c72;
      margin-bottom: 10px;
    }

    .product-price {
      font-size: 1.1rem;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .diff-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: #0f1017;
      border: 1px solid #1c1e2a;
      border-radius: 8px;
      font-size: 0.78rem;
      margin-bottom: 24px;
    }

    .diff-label { color: #5a5c72; flex: 1; }

    .diff-value {
      color: var(--accent2);
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .specs-section { margin-bottom: 24px; }

    .specs-title {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      color: #5a5c72;
      margin-bottom: 12px;
    }

    .specs-table-wrap {
      overflow-x: auto;
      border: 1px solid #1c1e2a;
      border-radius: 10px;
    }

    .specs-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.75rem;
    }

    .specs-table th,
    .specs-table td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid #1c1e2a;
      vertical-align: top;
      line-height: 1.45;
    }

    .specs-table th {
      background: #0f1017;
      color: #5a5c72;
      font-weight: 600;
      letter-spacing: 0.06em;
      font-size: 0.65rem;
      text-transform: uppercase;
      max-width: 200px;
      word-break: break-word;
    }

    .specs-table td {
      word-break: break-word;
      max-width: 220px;
    }

    .specs-table tbody tr:nth-child(even) td {
      background: rgba(255, 255, 255, 0.015);
    }

    .specs-table tbody tr:last-child td {
      border-bottom: none;
    }

    .specs-table tbody tr:hover {
      background: rgba(255,255,255,0.02);
    }

    .spec-name-cell { color: #c4c6d4; min-width: 140px; }

    .spec-label { display: block; font-weight: 600; }
    .spec-unit { display: block; font-size: 0.62rem; color: #5a5c72; margin-top: 2px; }

    .specs-table td.spec-diff {
      color: #fbbf24;
    }

    .compare-btn {
      background: var(--accent);
      color: #000;
      border: none;
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 700;
      padding: 10px 24px;
      border-radius: 8px;
      cursor: pointer;
      letter-spacing: 0.03em;
    }

    .compare-btn.secondary {
      background: transparent;
      color: #5a5c72;
      border: 1px solid #1c1e2a;
    }

    .compare-btn.secondary:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
  `]
})
export class ComparadorComponent implements OnChanges {
  @Input() selectedIds: number[] = [];
  @Output() clearSelection = new EventEmitter<void>();

  result: CompareApiResponse | null = null;
  partialProduct: ProductoDetalle | null = null;
  loading = false;
  loadingMode: 'partial' | 'compare' = 'compare';
  error = '';
  lastSource = '';
  latencyMs: number | null = null;

  get compareSpecs(): CompareSpecRow[] {
    return this.result?.data?.specs ?? [];
  }

  constructor(private svc: ProductService) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['selectedIds']) {
      this.onSelectionUpdated();
    }
  }

  private onSelectionUpdated() {
    this.result = null;
    this.error = '';
    this.partialProduct = null;

    const count = this.selectedIds.length;

    if (count > 2) {
      this.loading = false;
      return;
    }

    if (count === 0) {
      this.loading = false;
      return;
    }

    if (count === 1) {
      this.loadPartialProduct();
      return;
    }

    this.runCompare();
  }

  private loadPartialProduct() {
    const id = this.selectedIds[0];
    this.loading = true;
    this.loadingMode = 'partial';
    this.svc.getProduct(id).subscribe({
      next: (r) => {
        this.partialProduct = r.data;
        this.loading = false;
      },
      error: (e) => {
        this.error = this.backendMessage(e);
        this.loading = false;
      },
    });
  }

  runCompare() {
    if (this.selectedIds.length !== 2) {
      return;
    }

    this.loading = true;
    this.loadingMode = 'compare';
    this.error = '';
    this.result = null;
    this.lastSource = 'postgresql';
    const t0 = performance.now();

    const ids = [this.selectedIds[0], this.selectedIds[1]];

    this.svc.compare(ids).subscribe({
      next: (r) => {
        this.result = r;
        this.lastSource = r.source;
        this.latencyMs = Math.round(performance.now() - t0);
        this.loading = false;
      },
      error: (e) => {
        this.error = this.backendMessage(e);
        this.loading = false;
      },
    });
  }

  retryCompare() {
    this.runCompare();
  }

  resetResult() {
    this.result = null;
    if (this.selectedIds.length === 2) {
      this.runCompare();
    }
  }

  trackSpecRow(_index: number, row: CompareSpecRow): string {
    return row.key;
  }

  productColumnLabel(index: number): string {
    const p = this.result?.data?.products?.[index];
    if (!p) {
      return `Producto ${index + 1}`;
    }
    const short = p.modelo || p.nombre;
    return `${short} · ID ${p.id}`;
  }

  specValueFor(row: CompareSpecRow, productIndex: number): string | number | boolean | null {
    const productId = this.result?.data?.products?.[productIndex]?.id;
    if (productId == null) {
      return null;
    }
    const values = row.values ?? [];
    const entry = values.find((v) => v.product_id === productId);
    const raw = entry?.value;
    return raw === undefined ? null : raw;
  }

  formatSpecCell(row: CompareSpecRow, productIndex: number): string {
    const value = this.specValueFor(row, productIndex);
    if (value == null) {
      return '—';
    }
    if (typeof value === 'boolean') {
      return value ? 'Sí' : 'No';
    }
    const unit = row.unit ? ` ${row.unit}` : '';
    return `${value}${unit}`;
  }

  specValuesEqual(row: CompareSpecRow): boolean {
    const a = this.specValueFor(row, 0);
    const b = this.specValueFor(row, 1);
    if (a == null && b == null) {
      return true;
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      return a === b;
    }
    return String(a) === String(b);
  }

  onClear() {
    this.clearSelection.emit();
    this.result = null;
    this.partialProduct = null;
    this.error = '';
    this.loading = false;
  }

  formatPrice(precio: string | number | null | undefined): string {
    const n = Number(precio);
    if (!Number.isFinite(n)) {
      return '—';
    }
    return n.toLocaleString('es-MX', { minimumFractionDigits: 2 });
  }

  private backendMessage(err: unknown): string {
    if (err == null || typeof err !== 'object') {
      return 'Error al comparar';
    }
    const body = (err as { error?: unknown; message?: string }).error;
    if (typeof body === 'string' && body.trim() !== '') {
      return body;
    }
    if (body != null && typeof body === 'object' && 'error' in body) {
      const msg = (body as { error?: string }).error;
      if (typeof msg === 'string' && msg.trim() !== '') {
        return msg;
      }
    }
    const fallback = (err as { message?: string }).message;
    return fallback?.trim() ? fallback : 'Error al comparar';
  }
}
