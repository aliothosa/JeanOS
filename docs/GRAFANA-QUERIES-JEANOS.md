# Grafana — queries para JeanOS Shop

Guía de consultas para revisar el proyecto en **Grafana Explore** y en dashboards. Basada en el stack de observabilidad del bootcamp ([presentacion.html](https://github.com/dguerrero11/k8s-final)) y en las métricas propias del backend JeanOS (`prom-client` en `/metrics`).

## Acceso rápido

| Servicio | URL típica | Credenciales |
|----------|------------|--------------|
| Grafana | `http://<IP-NODO>:30300` | `admin` / `jeanos2026` |
| Prometheus | `http://<IP-NODO>:30900` | — |
| Tienda (frontend) | `http://<IP-NODO>:30080` | — |

**Datasources provisionados:** Prometheus (`uid: prometheus`), Loki (`uid: loki`).

**Uso en Grafana:** Explore → elegir datasource → modo **Code** → pegar query → Run query.

---

## Dashboards ya hechos para JeanOS

### 1. Dashboard provisionado del proyecto (recomendado)

JeanOS incluye un dashboard en el ConfigMap de Grafana:

- **Ruta en repo:** `ansible-k8s/manifests/monitoring/grafana/dashboards-configmap.yaml`
- **Título en UI:** `jeanOS — Hardware del cluster`
- **UID:** `jeanos-cluster-hardware`
- **Carpeta:** Dashboards → **JeanOS**

**Paneles incluidos:**

| Sección | Paneles |
|---------|---------|
| Nodos (node-exporter) | Nodos UP, CPU %, RAM %, disco %, red B/s |
| JeanOS Shop | Backend scrape UP, pods Running en `jeanos-shop`, HTTP req/s, Redis hits vs Postgres misses, latencia HTTP p95 |

**Queries ya embebidas en ese dashboard:**

```promql
# Nodos
count(up{job="node-exporter"} == 1)
100 - (avg by (instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m])) * 100)

# JeanOS backend
up{job="jeanos-backend"}
sum(kube_pod_status_phase{namespace="jeanos-shop",phase="Running"}) or vector(0)
sum(rate(jeanos_http_requests_total[5m]))
sum(rate(jeanos_cache_hits_total[5m]))
sum(rate(jeanos_cache_misses_total[5m]))
histogram_quantile(0.95, sum(rate(jeanos_http_request_duration_seconds_bucket[5m])) by (le))
```

Si no lo ves tras desplegar Semana 3:

```bash
kubectl rollout restart deployment/grafana -n monitoring
```

Documentación de despliegue: `docs/semana-3-monitoring.md`.

### 2. Dashboard del backend (API JeanOS)

Dashboard dedicado a las métricas de aplicación del backend (Express + `prom-client`):

- **Ruta en repo:** `ansible-k8s/manifests/monitoring/grafana/dashboard-backend-configmap.yaml`
- **Título en UI:** `jeanOS — Backend API`
- **UID:** `jeanos-backend-api`
- **Carpeta:** Dashboards → **JeanOS**
- **Variable de plantilla:** `route` (multi-selección por ruta)

**Paneles incluidos:**

| Sección | Paneles |
|---------|---------|
| Estado y tráfico HTTP | Backend UP, req/s total, % éxito 2xx, errores 5xx/s, latencia p95, req/s por ruta, req/s por código |
| Latencia | p50/p95/p99 global, p95 por ruta |
| Caché | Ratio de acierto, Redis hits vs PostgreSQL misses por ruta |
| Comparador (`/api/compare`) | req/s por fuente, errores 4xx/5xx, latencia p95 por fuente |
| Recursos del pod (cAdvisor) | CPU por pod backend, memoria por pod backend |

Este dashboard se provisiona desde su propio ConfigMap (`grafana-dashboard-backend`),
montado en `/var/lib/grafana/dashboards-backend` con un provider independiente, para
evitar el crash `not a directory` que provoca usar `subPath` dentro de un directorio
de ConfigMap ya montado.

> Los paneles de recursos del pod requieren el job `kubernetes-cadvisor` de Prometheus
> (métricas `container_*`). Ver `docs/semana-3-monitoring.md`.

### 2. Dashboards comunitarios (importar por ID)

Desde la presentación del bootcamp — Grafana → **Dashboards → Import**:

| ID | Dashboard | Uso en JeanOS |
|----|-----------|---------------|
| **1860** | Node Exporter Full | CPU/RAM/disco/red por nodo |
| **15520** | K8s All-in-one Monitoring | Vista general del cluster |
| **8588** | K8s Deployments / Daemonsets | Estado de deployments en `jeanos-shop` |
| **6417** | Kubernetes Cluster Overview | Cluster completo |
| **15141** | Loki Quick Search | Logs por namespace/pod |
| **13639** | Logs / App | Explorador de logs |
| **9578** | AlertManager Overview | Alertas activas |
| **14584** | ArgoCD | Sync/health de `jeanos-shop-gitops` |

Al importar, selecciona datasource **Prometheus** para métricas y **Loki** para logs.

### 3. Lo que no hay aún

No hay un dashboard Grafana **solo de API backend** (por ruta, errores 4xx/5xx, comparador desglosado). Las queries de la sección siguiente cubren ese hueco en **Explore** o para ampliar el ConfigMap.

---

## Métricas expuestas por el backend

Scrape Prometheus: job `jeanos-backend` → `jeanos-backend-service.jeanos-shop.svc:3000/metrics`.

| Métrica | Labels | Descripción |
|---------|--------|-------------|
| `jeanos_http_requests_total` | `method`, `route`, `status_code` | Todas las peticiones HTTP |
| `jeanos_http_request_duration_seconds` | `method`, `route`, `status_code` | Latencia por petición |
| `jeanos_cache_hits_total` | `route`, `source` | Respuestas desde Redis |
| `jeanos_cache_misses_total` | `route`, `source` | Fallback a PostgreSQL |
| `jeanos_comparator_requests_total` | `status_code`, `source` | Solo `POST /api/compare` |
| `jeanos_comparator_duration_seconds` | `status_code`, `source` | Latencia del comparador |

Rutas típicas en `route`: `/api/classes`, `/api/products`, `/api/products/:id`, `/api/compare`, `/healthz`, `/readyz`, `/metrics`.

Verificar que Prometheus scrapea:

```promql
up{job="jeanos-backend"}
```

Debe devolver `1`.

---

## Prometheus — peticiones al backend (JeanOS)

### Salud y disponibilidad

```promql
# ¿Prometheus alcanza el backend?
up{job="jeanos-backend"}

# Pods backend Running
kube_pod_status_phase{namespace="jeanos-shop", pod=~"jeanos-backend.*", phase="Running"}

# Restarts recientes del backend (posible CrashLoop)
increase(kube_pod_container_status_restarts_total{namespace="jeanos-shop", container="backend"}[15m])
```

### Tráfico HTTP global

```promql
# Peticiones por segundo (todas las rutas)
sum(rate(jeanos_http_requests_total[5m]))

# Por ruta (catálogo, compare, health…)
sum(rate(jeanos_http_requests_total[5m])) by (route)

# Por método y ruta
sum(rate(jeanos_http_requests_total[5m])) by (method, route)

# Solo API de catálogo (sin /metrics ni probes)
sum(rate(jeanos_http_requests_total{route=~"/api/.*"}[5m])) by (route)
```

### Errores y códigos HTTP

```promql
# Tasa de errores 5xx
sum(rate(jeanos_http_requests_total{status_code=~"5.."}[5m]))

# Tasa de 4xx (validación compare, clase distinta, etc.)
sum(rate(jeanos_http_requests_total{status_code=~"4.."}[5m])) by (route, status_code)

# % de éxito (2xx) sobre total API
sum(rate(jeanos_http_requests_total{route=~"/api/.*", status_code=~"2.."}[5m]))
/
sum(rate(jeanos_http_requests_total{route=~"/api/.*"}[5m]))
* 100

# Errores por ruta
sum(rate(jeanos_http_requests_total{status_code=~"4..|5.."}[5m])) by (route, status_code)
```

### Latencia HTTP

```promql
# p50 / p95 / p99 global
histogram_quantile(0.50, sum(rate(jeanos_http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.95, sum(rate(jeanos_http_request_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.99, sum(rate(jeanos_http_request_duration_seconds_bucket[5m])) by (le))

# p95 por ruta (útil para ver si /api/compare es más lento)
histogram_quantile(0.95,
  sum(rate(jeanos_http_request_duration_seconds_bucket[5m])) by (le, route)
) 

# Latencia media por ruta
sum(rate(jeanos_http_request_duration_seconds_sum[5m])) by (route)
/
sum(rate(jeanos_http_request_duration_seconds_count[5m])) by (route)
```

### Redis vs PostgreSQL (demo Semana 3)

```promql
# Hits Redis por ruta
sum(rate(jeanos_cache_hits_total[5m])) by (route)

# Misses → Postgres por ruta
sum(rate(jeanos_cache_misses_total[5m])) by (route)

# Ratio de acierto cache (API con caché)
sum(rate(jeanos_cache_hits_total[5m]))
/
(sum(rate(jeanos_cache_hits_total[5m])) + sum(rate(jeanos_cache_misses_total[5m])))
* 100

# Solo catálogo en Redis
sum(rate(jeanos_cache_hits_total{route="/api/products"}[5m]))
```

### Comparador (`POST /api/compare`)

```promql
# Peticiones compare/s
sum(rate(jeanos_comparator_requests_total[5m]))

# Compare por fuente de datos (redis vs postgresql vs none en errores)
sum(rate(jeanos_comparator_requests_total[5m])) by (source)

# Errores en compare (4xx/5xx)
sum(rate(jeanos_comparator_requests_total{status_code=~"4..|5.."}[5m])) by (status_code, source)

# Latencia p95 del comparador
histogram_quantile(0.95,
  sum(rate(jeanos_comparator_duration_seconds_bucket[5m])) by (le, source)
)

# Compare exitoso desde Redis (demo “wow”)
sum(rate(jeanos_comparator_requests_total{status_code="200", source="redis"}[5m]))
```

### Recursos del pod backend (cAdvisor / kubelet)

```promql
# CPU del contenedor backend
sum(rate(container_cpu_usage_seconds_total{
  namespace="jeanos-shop",
  pod=~"jeanos-backend.*",
  container="backend"
}[5m])) by (pod)

# RAM working set
sum(container_memory_working_set_bytes{
  namespace="jeanos-shop",
  pod=~"jeanos-backend.*",
  container="backend"
}) by (pod)
```

---

## Loki — logs del backend y JeanOS Shop

Datasource: **Loki**.

```logql
# Todo el namespace de la tienda
{namespace="jeanos-shop"}

# Solo contenedor backend
{namespace="jeanos-shop", container="backend"}

# Init preload-redis
{namespace="jeanos-shop", container="preload-redis"}

# Errores en backend
{namespace="jeanos-shop", container="backend"} |~ "(?i)(error|exception|fatal|ECONNREFUSED)"

# Líneas que mencionan compare o Redis
{namespace="jeanos-shop", container="backend"} |~ "compare|redis|PostgreSQL"

# Tasa de líneas con "error" por pod
sum by (pod) (
  rate({namespace="jeanos-shop", container="backend"} |~ "(?i)error" [1m])
)
```

---

## Kubernetes — namespace `jeanos-shop`

Queries útiles de la presentación del bootcamp, adaptadas a JeanOS:

```promql
# ¿Deployments sin réplicas disponibles?
kube_deployment_status_replicas_available{namespace="jeanos-shop"}
  <
kube_deployment_spec_replicas{namespace="jeanos-shop"}

# Pods en CrashLoop (cualquier namespace; filtrar jeanos-shop)
increase(kube_pod_container_status_restarts_total{namespace="jeanos-shop"}[15m]) > 3

# Top CPU en jeanos-shop
topk(5,
  sum by (pod) (
    rate(container_cpu_usage_seconds_total{
      namespace="jeanos-shop", container!="", container!="POD"
    }[2m])
  )
)

# Top RAM en jeanos-shop
topk(5,
  sum by (pod) (
    container_memory_working_set_bytes{
      namespace="jeanos-shop", container!="", container!="POD"
    }
  )
)
```

---

## Tekton y ArgoCD (Semana 4)

Si Semana 4 está desplegada y Prometheus scrapea esos jobs:

```promql
# PipelineRuns Tekton
tekton_pipelines_controller_pipelinerun_total
rate(tekton_pipelines_controller_pipelinerun_duration_seconds_count[5m])

# ArgoCD — app de la tienda
argocd_app_info{name="jeanos-shop-gitops"}
argocd_app_sync_total{name="jeanos-shop-gitops"}
```

Logs Tekton:

```logql
{namespace="tekton-pipelines"} |= "jeanos-shop"
```

Logs ArgoCD:

```logql
{namespace="argocd"} |= "jeanos-shop-gitops"
```

---

## Generar tráfico para ver métricas

Sustituye `<IP-NODO>` por la IP de un nodo del cluster:

```bash
NODE_IP=<IP-NODO>

# Catálogo (Redis/Postgres)
curl -s "http://${NODE_IP}:30080/api/classes" > /dev/null
curl -s "http://${NODE_IP}:30080/api/products?class=gpu" > /dev/null
curl -s "http://${NODE_IP}:30080/api/products/1" > /dev/null

# Comparador (3 productos misma clase — GPU)
curl -s -X POST "http://${NODE_IP}:30080/api/compare" \
  -H "Content-Type: application/json" \
  -d '{"ids":[1,2,3]}' > /dev/null

# Repetir compare para ver subida de jeanos_cache_hits_total (Redis)
curl -s -X POST "http://${NODE_IP}:30080/api/compare" \
  -H "Content-Type: application/json" \
  -d '{"ids":[1,2,3]}' > /dev/null
```

Desde dentro del cluster:

```bash
kubectl run curl-traffic --rm -it --restart=Never -n jeanos-shop \
  --image=curlimages/curl:8.5.0 -- \
  sh -c '
    curl -sf http://jeanos-backend-service:3000/api/classes
    curl -sf "http://jeanos-backend-service:3000/api/products?class=gpu"
    curl -sf -X POST http://jeanos-backend-service:3000/api/compare \
      -H "Content-Type: application/json" -d "{\"ids\":[1,2,3]}"
  '
```

---

## Troubleshooting rápido

| Síntoma | Query / acción |
|---------|----------------|
| `up{job="jeanos-backend"} == 0` | `kubectl get pods,svc -n jeanos-shop`; revisar target en Prometheus `:30900/targets` |
| HTTP req/s en 0 tras tráfico | Imagen backend antigua sin `/metrics`; rebuild + rollout |
| Solo Postgres misses | Redis caído o preload-redis falló; logs `{namespace="jeanos-shop", container="preload-redis"}` |
| p95 alto en `/api/compare` | Normal en primer miss; segundo hit debería bajar si Redis OK |
| Grafana sin dashboard JeanOS | `kubectl get cm grafana-dashboards -n monitoring`; restart grafana |

---

## Referencias en el repo

- Despliegue monitoring: `docs/semana-3-monitoring.md`
- Dashboard JSON: `ansible-k8s/manifests/monitoring/grafana/dashboards-configmap.yaml`
- Scrape backend: `ansible-k8s/manifests/monitoring/prometheus/configmap.yaml` (job `jeanos-backend`)
- Código métricas: `app/backend/index.js`
