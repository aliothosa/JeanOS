import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** Número exacto de productos que acepta el comparador (misma clase). */
export const COMPARE_PRODUCT_COUNT = 3;

/** Respuesta envoltorio del backend (Redis / PostgreSQL). */
export interface CachedApiResponse<T> {
  source: 'redis' | 'postgresql';
  ttl_seconds: number;
  data: T;
}

export interface ClaseProducto {
  id: number;
  slug: string;
  nombre: string;
  descripcion: string | null;
}

export interface ProductClass {
  id: number;
  slug: string;
  nombre: string;
}

export interface ProductSpec {
  key: string;
  label: string;
  unit: string | null;
  data_type?: string;
  value: string | number | boolean | null;
  sort_order?: number;
}

export interface Producto {
  id: number;
  nombre: string;
  marca: string;
  modelo: string;
  precio: string;
  clase: ProductClass;
}

export interface ProductoDetalle {
  id: number;
  nombre: string;
  marca: string;
  modelo: string;
  precio: string;
  clase: ClaseProducto;
  specs: ProductSpec[];
}

export interface CompareRequest {
  ids: number[];
}

export interface CompareSpecValue {
  product_id: number;
  value: string | number | boolean | null;
}

export interface CompareSpecRow {
  key: string;
  label: string;
  unit: string | null;
  values: CompareSpecValue[];
}

export interface CompareProductSummary {
  id: number;
  nombre: string;
  marca: string;
  modelo: string;
  precio: number;
}

export interface CompareClassInfo {
  id: number;
  slug: string;
  nombre: string;
}

export interface CompareResponse {
  class: CompareClassInfo;
  products: CompareProductSummary[];
  specs: CompareSpecRow[];
  price_difference: number;
  cheapest_product: {
    id: number;
    nombre: string;
    precio: number;
  };
}

export type ClasesApiResponse = CachedApiResponse<ClaseProducto[]>;
export type ProductosResponse = CachedApiResponse<Producto[]>;
export type ProductoDetalleResponse = CachedApiResponse<ProductoDetalle>;
export type CompareApiResponse = CachedApiResponse<CompareResponse>;

/**
 * @deprecated Usar CompareResponse dentro de CompareApiResponse.
 * Se mantiene hasta migrar comparador.component.
 */
export interface ComparacionData {
  requested_ids: number[];
  count: number;
  cheapest: Producto;
  most_expensive: Producto;
  price_difference: number;
  products: Producto[];
}

/**
 * @deprecated Usar CompareApiResponse.
 */
export type ComparacionResponse = CachedApiResponse<ComparacionData>;

@Injectable({ providedIn: 'root' })
export class ProductService {
  private api = environment.apiUrl;

  constructor(private http: HttpClient) {}

  getClasses(): Observable<ClasesApiResponse> {
    return this.http.get<ClasesApiResponse>(`${this.api}/api/classes`);
  }

  getProducts(classSlug?: string): Observable<ProductosResponse> {
    let params = new HttpParams();
    if (classSlug != null && classSlug.trim() !== '') {
      params = params.set('class', classSlug.trim().toLowerCase());
    }
    return this.http.get<ProductosResponse>(`${this.api}/api/products`, { params });
  }

  getProduct(id: number): Observable<ProductoDetalleResponse> {
    return this.http.get<ProductoDetalleResponse>(`${this.api}/api/products/${id}`);
  }

  compare(ids: number[]): Observable<CompareApiResponse> {
    const body: CompareRequest = { ids };
    return this.http.post<CompareApiResponse>(`${this.api}/api/compare`, body);
  }
}
