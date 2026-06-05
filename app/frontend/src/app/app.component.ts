import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CatalogoComponent } from './components/catalogo/catalogo.component';
import { ComparadorComponent } from './components/comparador/comparador.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, CatalogoComponent, ComparadorComponent],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-icon">⬡</span>
            <span class="brand-name">jeanOS<em>Shop</em></span>
          </div>
          <nav class="nav-tabs">
            <button [class.active]="view === 'catalogo'" (click)="view='catalogo'">Catálogo</button>
            <button [class.active]="view === 'comparador'" (click)="view='comparador'">
              Comparador
              <span class="badge" *ngIf="selectedIds.length > 0">{{ selectedIds.length }}</span>
            </button>
          </nav>
          <div class="cluster-pill">
            <span class="dot"></span>
            K8s · jeanOS
          </div>
        </div>
      </header>

      <main class="main-content">
        <app-catalogo
          *ngIf="view === 'catalogo'"
          (selectionChange)="onSelectionChange($event)"
          [selectedIds]="selectedIds"
        ></app-catalogo>
        <app-comparador
          *ngIf="view === 'comparador'"
          [selectedIds]="selectedIds"
          (clearSelection)="clearSelection()"
        ></app-comparador>
      </main>
    </div>
  `,
  styles: [`
    :host {
      --bg: #08090d;
      --surface: #0f1017;
      --border: #1c1e2a;
      --text: #e8eaf2;
      --muted: #5a5c72;
      --accent: #84cc16;
      --accent2: #22d3ee;
      display: block;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: 'IBM Plex Mono', monospace;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(8,9,13,0.92);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
    }

    .topbar-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px;
      height: 56px;
      display: flex;
      align-items: center;
      gap: 32px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .brand-icon {
      color: var(--accent);
      font-size: 1.3rem;
    }

    .brand-name em {
      font-style: normal;
      color: var(--accent);
    }

    .nav-tabs {
      display: flex;
      gap: 4px;
      flex: 1;
    }

    .nav-tabs button {
      background: none;
      border: none;
      color: var(--muted);
      font-family: inherit;
      font-size: 0.78rem;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .nav-tabs button:hover { color: var(--text); background: rgba(255,255,255,0.04); }
    .nav-tabs button.active { color: var(--accent); background: rgba(132,204,22,0.08); }

    .badge {
      background: var(--accent);
      color: #000;
      font-size: 0.6rem;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 100px;
    }

    .cluster-pill {
      font-size: 0.65rem;
      color: var(--muted);
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .main-content {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
    }
  `]
})
export class AppComponent {
  view: 'catalogo' | 'comparador' = 'catalogo';
  selectedIds: number[] = [];

  onSelectionChange(ids: number[]) {
    this.selectedIds = [...ids];
  }

  clearSelection() {
    this.selectedIds = [];
  }
}
