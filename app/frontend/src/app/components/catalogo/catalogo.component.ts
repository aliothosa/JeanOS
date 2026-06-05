import { Component, OnInit, Output, Input, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ProductService,
  Producto,
  ClaseProducto,
  ProductSpec,
  COMPARE_PRODUCT_COUNT,
} from '../../services/product.service';

@Component({
  selector: 'app-catalogo',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="catalogo">
      <div class="section-header">
        <div class="section-label">CATÁLOGO · {{ productos.length }} productos</div>
        <div class="header-actions">
          <button
            type="button"
            class="clear-btn"
            *ngIf="selectedIds.length > 0"
            (click)="clearSelection()"
          >
            Limpiar selección
          </button>
          <div class="source-tag" [class.redis]="source === 'redis'" [class.pg]="source === 'postgresql'" *ngIf="source">
            <span class="source-dot"></span>
            {{ source === 'redis' ? 'Redis cache' : 'PostgreSQL' }}
            <span class="ttl" *ngIf="ttl != null">· TTL {{ ttl }}s</span>
          </div>
        </div>
      </div>

      <div class="class-filters" *ngIf="clases.length > 0 && !loadingClasses">
        <button
          type="button"
          class="filter-chip"
          [class.active]="activeClassSlug === null"
          (click)="filterByClass(null)"
        >
          Todas
        </button>
        <button
          type="button"
          class="filter-chip"
          *ngFor="let c of clases"
          [class.active]="activeClassSlug === c.slug"
          (click)="filterByClass(c.slug)"
        >
          {{ c.nombre }}
        </button>
      </div>

      <div class="hint" *ngIf="!loading && !error">
        <ng-container *ngIf="selectedIds.length === 0">
          Selecciona {{ compareCount }} productos de la misma clase para comparar
        </ng-container>
        <ng-container *ngIf="selectedIds.length > 0 && selectedIds.length < compareCount">
          {{ selectedIds.length }}/{{ compareCount }} seleccionados · elige otro producto de
          <strong>{{ lockedClassLabel() }}</strong>
        </ng-container>
        <ng-container *ngIf="selectedIds.length === compareCount">
          <span class="hint-ready">✓ {{ compareCount }} productos listos — ve al comparador</span>
        </ng-container>
      </div>

      <div class="selection-msg" *ngIf="selectionMessage">
        ⚠ {{ selectionMessage }}
      </div>

      <div class="loading" *ngIf="loading || loadingClasses">
        <div class="spinner"></div>
        {{ loadingClasses ? 'Cargando clases...' : 'Cargando catálogo...' }}
      </div>

      <div class="error" *ngIf="error && !loading">
        ⚠ {{ error }}
        <button type="button" (click)="reload()">Reintentar</button>
      </div>

      <div class="grid" *ngIf="!loading && !error">
        <div
          class="card"
          *ngFor="let p of productos"
          [class.selected]="isSelected(p.id)"
          [class.disabled]="isCardDisabled(p)"
          (click)="toggle(p)"
        >
          <div class="card-top">
            <span class="card-class">{{ p.clase.nombre }}</span>
            <div class="card-check" *ngIf="isSelected(p.id)">✓</div>
          </div>
          <div class="card-id">ID · {{ p.id }}</div>
          <div class="card-name">{{ p.nombre }}</div>
          <div class="card-meta">{{ p.marca }} · {{ p.modelo }}</div>
          <div class="card-price">\${{ formatPrice(p.precio) }}</div>
          <ul class="card-specs" *ngIf="mainSpecs(p.id).length > 0">
            <li *ngFor="let s of mainSpecs(p.id)">
              <span class="spec-label">{{ s.label }}</span>
              <span class="spec-value">{{ formatSpecValue(s) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="empty" *ngIf="!loading && !error && productos.length === 0">
        No hay productos en esta clase.
      </div>
    </div>
  `,
  styles: [`
    .catalogo {
      --accent: #84cc16;
      --accent2: #22d3ee;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 12px;
      flex-wrap: wrap;
    }

    .section-label {
      font-size: 0.65rem;
      letter-spacing: 0.2em;
      color: #5a5c72;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .clear-btn {
      background: none;
      border: 1px solid #1c1e2a;
      color: #5a5c72;
      font-family: inherit;
      font-size: 0.68rem;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      letter-spacing: 0.05em;
    }

    .clear-btn:hover {
      border-color: #f87171;
      color: #f87171;
    }

    .source-tag {
      font-size: 0.65rem;
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 100px;
      border: 1px solid #1c1e2a;
    }

    .source-tag.redis { color: #22d3ee; border-color: rgba(34,211,238,0.2); }
    .source-tag.pg { color: #a78bfa; border-color: rgba(167,139,250,0.2); }

    .source-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    .class-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 16px;
    }

    .filter-chip {
      background: #0f1017;
      border: 1px solid #1c1e2a;
      color: #5a5c72;
      font-family: inherit;
      font-size: 0.68rem;
      padding: 6px 12px;
      border-radius: 100px;
      cursor: pointer;
      letter-spacing: 0.06em;
      transition: all 0.15s;
    }

    .filter-chip:hover {
      border-color: rgba(132,204,22,0.35);
      color: #e8eaf2;
    }

    .filter-chip.active {
      background: rgba(132,204,22,0.1);
      border-color: var(--accent);
      color: var(--accent);
    }

    .hint {
      font-size: 0.72rem;
      color: #5a5c72;
      margin-bottom: 12px;
      letter-spacing: 0.05em;
    }

    .hint strong { color: #e8eaf2; font-weight: 600; }
    .hint-ready { color: var(--accent); }

    .selection-msg {
      font-size: 0.72rem;
      color: #fbbf24;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: rgba(251,191,36,0.06);
      border: 1px solid rgba(251,191,36,0.25);
      border-radius: 8px;
    }

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

    .empty {
      font-size: 0.8rem;
      color: #5a5c72;
      padding: 40px 0;
      text-align: center;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 2px;
    }

    .card {
      background: #0f1017;
      border: 1px solid #1c1e2a;
      border-radius: 10px;
      padding: 18px;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 1px;
      background: transparent;
      transition: background 0.15s;
    }

    .card:hover:not(.disabled) {
      border-color: rgba(132,204,22,0.3);
      background: #12141c;
    }

    .card:hover:not(.disabled)::before {
      background: var(--accent);
    }

    .card.selected {
      border-color: var(--accent);
      background: rgba(132,204,22,0.06);
    }

    .card.selected::before {
      background: var(--accent);
    }

    .card.disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .card-class {
      font-size: 0.58rem;
      letter-spacing: 0.12em;
      color: var(--accent2);
      text-transform: uppercase;
    }

    .card-id {
      font-size: 0.6rem;
      color: #5a5c72;
      letter-spacing: 0.15em;
      margin-bottom: 6px;
    }

    .card-name {
      font-size: 0.85rem;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 4px;
      color: #e8eaf2;
    }

    .card-meta {
      font-size: 0.68rem;
      color: #5a5c72;
      margin-bottom: 10px;
    }

    .card-price {
      font-size: 1.1rem;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 10px;
    }

    .card-specs {
      list-style: none;
      margin: 0;
      padding: 0;
      border-top: 1px solid #1c1e2a;
      padding-top: 10px;
    }

    .card-specs li {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.62rem;
      margin-bottom: 4px;
    }

    .spec-label { color: #5a5c72; }
    .spec-value { color: #c4c6d4; text-align: right; }

    .card-check {
      width: 20px;
      height: 20px;
      background: var(--accent);
      color: #000;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.65rem;
      font-weight: 900;
      flex-shrink: 0;
    }
  `]
})
export class CatalogoComponent implements OnInit {
  @Input() selectedIds: number[] = [];
  @Output() selectionChange = new EventEmitter<number[]>();

  clases: ClaseProducto[] = [];
  productos: Producto[] = [];
  specsByProductId = new Map<number, ProductSpec[]>();

  activeClassSlug: string | null = null;
  loadingClasses = true;
  loading = true;
  error = '';
  selectionMessage = '';
  source = '';
  ttl: number | null = null;

  readonly compareCount = COMPARE_PRODUCT_COUNT;
  private readonly maxSelection = COMPARE_PRODUCT_COUNT;
  private readonly maxSpecsOnCard = 3;

  constructor(private svc: ProductService) {}

  ngOnInit() {
    this.loadClasses();
  }

  loadClasses() {
    this.loadingClasses = true;
    this.svc.getClasses().subscribe({
      next: (r) => {
        this.clases = r.data;
        this.loadingClasses = false;
        this.loadProducts();
      },
      error: (e) => {
        this.loadingClasses = false;
        this.error = e.error?.error || e.message || 'Error al cargar clases';
        this.loading = false;
      },
    });
  }

  filterByClass(slug: string | null) {
    if (this.activeClassSlug === slug) {
      return;
    }
    this.activeClassSlug = slug;
    this.selectionMessage = '';
    this.loadProducts();
  }

  loadProducts() {
    this.loading = true;
    this.error = '';
    this.specsByProductId.clear();

    const slug = this.activeClassSlug ?? undefined;
    this.svc.getProducts(slug).subscribe({
      next: (r) => {
        this.productos = r.data;
        this.source = r.source;
        this.ttl = r.ttl_seconds;
        this.loading = false;
        this.syncSelectionWithCatalog();
        this.loadMainSpecs();
      },
      error: (e) => {
        this.error = e.error?.error || e.message || 'Error al cargar productos';
        this.loading = false;
      },
    });
  }

  reload() {
    this.selectionMessage = '';
    this.loadClasses();
  }

  /** Mantiene solo IDs que siguen en el listado visible. */
  private syncSelectionWithCatalog() {
    const visible = this.selectedIds.filter((id) =>
      this.productos.some((p) => p.id === id),
    );
    if (visible.length !== this.selectedIds.length) {
      this.selectionChange.emit(visible);
    }
  }

  private loadMainSpecs() {
    if (this.productos.length === 0) {
      return;
    }

    const requests = this.productos.map((p) =>
      this.svc.getProduct(p.id).pipe(
        catchError(() => of(null)),
      ),
    );

    forkJoin(requests).subscribe((responses) => {
      for (const res of responses) {
        if (!res?.data) {
          continue;
        }
        const top = res.data.specs.slice(0, this.maxSpecsOnCard);
        this.specsByProductId.set(res.data.id, top);
      }
    });
  }

  mainSpecs(productId: number): ProductSpec[] {
    return this.specsByProductId.get(productId) ?? [];
  }

  formatSpecValue(s: ProductSpec): string {
    if (s.value == null) {
      return '—';
    }
    const unit = s.unit ? ` ${s.unit}` : '';
    return `${s.value}${unit}`;
  }

  lockedClassSlug(): string | null {
    if (this.selectedIds.length === 0) {
      return null;
    }
    const first = this.productos.find((p) => p.id === this.selectedIds[0]);
    return first?.clase.slug ?? null;
  }

  lockedClassLabel(): string {
    const slug = this.lockedClassSlug();
    if (!slug) {
      return '';
    }
    const fromList = this.productos.find((p) => p.clase.slug === slug);
    return fromList?.clase.nombre ?? slug.toUpperCase();
  }

  isSelected(id: number): boolean {
    return this.selectedIds.includes(id);
  }

  isCardDisabled(p: Producto): boolean {
    if (this.isSelected(p.id)) {
      return false;
    }
    if (this.selectedIds.length >= this.maxSelection) {
      return true;
    }
    const locked = this.lockedClassSlug();
    if (locked && p.clase.slug !== locked) {
      return true;
    }
    return false;
  }

  toggle(p: Producto) {
    this.selectionMessage = '';

    if (this.isSelected(p.id)) {
      this.selectionChange.emit(this.selectedIds.filter((id) => id !== p.id));
      return;
    }

    if (this.selectedIds.length >= this.maxSelection) {
      return;
    }

    const locked = this.lockedClassSlug();
    if (locked && p.clase.slug !== locked) {
      this.selectionMessage =
        `Solo puedes comparar productos de la misma clase. Ya seleccionaste uno de ${this.lockedClassLabel()}; no puedes añadir ${p.clase.nombre}.`;
      return;
    }

    this.selectionChange.emit([...this.selectedIds, p.id]);
  }

  clearSelection() {
    this.selectionMessage = '';
    this.selectionChange.emit([]);
  }

  formatPrice(precio: string): string {
    return Number(precio).toLocaleString('es-MX', { minimumFractionDigits: 2 });
  }
}
