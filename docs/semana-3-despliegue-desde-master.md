# Semana 3 — Despliegue del stack de observabilidad desde el master

Guía para ejecutar en **k8s-master01** (o cualquier nodo con `kubectl` configurado contra el cluster). Stack: **Prometheus**, **Grafana**, **Node Exporter**, **kube-state-metrics**, **Loki**, **Promtail**, **Tempo**.

Grafana correlaciona **métricas** (Prometheus), **logs** (Loki) y **trazas** (Tempo). No incluye Tekton ni ArgoCD.

### Componentes del stack

| Componente | Namespace | Almacenamiento | Acceso UI (NodePort) |
|------------|-----------|----------------|----------------------|
| Node Exporter | `monitoring` | — (host) | — (`:9100` por IP de nodo) |
| kube-state-metrics | `monitoring` | — | — (solo cluster) |
| Loki | `monitoring` | PVC `nfs-client` | — (vía Grafana) |
| **Tempo** | `monitoring` | `emptyDir` (WAL local) | — (vía Grafana Explore) |
| Promtail | `monitoring` | — (host `/var/log`) | — |
| Prometheus | `monitoring` | PVC `nfs-client` | `http://<NODE_IP>:30900` |
| Grafana | `monitoring` | PVC `nfs-client` | `http://<NODE_IP>:30300` |
| JeanOS backend | `jeanos-shop` | — | métricas en `:3000/metrics` |

### Arquitectura (métricas + logs + trazas)

```text
  Nodos (node-exporter :9100)
         │
         ▼
  Prometheus ◄──── scrape ──── jeanos-backend /metrics (jeanos_*)
       │  ▲
       │  └── job tempo :3200/metrics
       │
  Grafana ──┬── datasource Prometheus (métricas, default)
            ├── datasource Loki (logs jeanos-shop)
            └── datasource Tempo (trazas)
                    │
                    ├── tracesToMetrics → Prometheus
                    └── tracesToLogs → Loki

  Pods (logs) → Promtail → Loki
  App (futuro OTLP) → Tempo :4317/:4318
```

Manifiestos Tempo en el repo: `ansible-k8s/manifests/monitoring/tempo/` (basado en `examples/07-tempo.yaml`).

---

## 1. Dónde ejecutar los comandos

| Máquina | Rol |
|---------|-----|
| **k8s-master01** (`192.168.41.154` en el lab por defecto) | Aplicar manifiestos con `kubectl` |
| Workers | Solo reciben DaemonSets (node-exporter, promtail); no hace falta SSH salvo firewall |

Clona o actualiza el repo en el master:

```bash
cd /root   # o tu directorio de trabajo
git clone https://github.com/<tu-usuario>/JeanOS.git
cd JeanOS
```

Ajusta la URL a tu fork. Si ya tienes el repo:

```bash
cd JeanOS
git pull
```

Comprueba acceso al cluster:

```bash
kubectl get nodes -o wide
kubectl cluster-info
```

---

## 2. Prerrequisitos en el cluster

### 2.1 StorageClass NFS (`nfs-client`)

Todos los PVC de monitoreo usan **`nfs-client`**, no `nfs-csi`.

```bash
kubectl get storageclass nfs-client
kubectl get pods -n nfs-provisioner
```

Si no existe, despliega primero el provisioner (desde el master, en la raíz del repo):

```bash
kubectl apply -f ansible-k8s/manifests/namespace/jeanos-shop.yaml
kubectl apply -f ansible-k8s/manifests/storage/nfs-subdir-provisioner.yaml
kubectl wait --for=condition=available deployment/nfs-client-provisioner \
  -n nfs-provisioner --timeout=300s
```

### 2.2 Aplicación JeanOS Shop (recomendado antes de scrape)

Prometheus espera métricas en `jeanos-backend-service.jeanos-shop.svc:3000/metrics`.

```bash
kubectl get pods -n jeanos-shop
kubectl get svc -n jeanos-shop
```

Si la tienda no está desplegada:

```bash
chmod +x ansible-k8s/deploy-jeanos.sh
./ansible-k8s/deploy-jeanos.sh --yes
```

### 2.3 Imagen del backend con `prom-client`

El endpoint `/metrics` y las métricas `jeanos_*` deben estar **dentro de la imagen** que usa el Deployment.

En el master (con Docker y acceso al registry):

```bash
cd JeanOS/app/backend
docker build -t <tu-registry>/jeanos-backend:v1 .
docker push <tu-registry>/jeanos-backend:v1

kubectl rollout restart deployment/jeanos-backend -n jeanos-shop
kubectl rollout status deployment/jeanos-backend -n jeanos-shop
```

Usa el mismo tag que en `ansible-k8s/manifests/backend/backend-deployment.yaml`. Unifica registry entre el contenedor `backend` y el init `preload-redis`.

Comprobación rápida:

```bash
kubectl run curl-metrics --rm -it --restart=Never -n jeanos-shop \
  --image=curlimages/curl:latest -- \
  curl -s http://jeanos-backend-service:3000/metrics | grep '^jeanos_'
```

### 2.4 IPs de los nodos (Node Exporter)

Prometheus hace scrape por IP en el puerto **9100**. Verifica que coincidan con tu cluster:

```bash
kubectl get nodes -o wide
```

Por defecto en el repo:

| Nodo | IP |
|------|-----|
| master | `192.168.41.154` |
| worker01 | `192.168.41.157` |
| worker02 | `192.168.41.158` |

Si tus IPs son otras, edita **antes de aplicar**:

```bash
vi ansible-k8s/manifests/monitoring/prometheus/configmap.yaml
# job_name: node-exporter → targets
```

### 2.5 Tempo (trazas) — prerequisito conceptual

Tempo **no usa** `nfs-client` (el WAL en NFS suele fallar). Se despliega con volumen **`emptyDir`** en el pod.

| Uso | Detalle |
|-----|---------|
| Métricas de la tienda | Siguen en **Prometheus** (`jeanos_*`); no pasan por Tempo |
| Trazas de requests | Requieren **OpenTelemetry** en el backend → `http://tempo.monitoring.svc:4317` (gRPC) o `:4318` (HTTP) |
| Ver en Grafana | **Explore → Tempo**; desde una traza: enlaces a **Metrics** y **Logs** |

Sin OTLP en el backend, Tempo queda **listo** pero Explore puede no mostrar trazas de JeanOS; Prometheus y Loki siguen funcionando.

### 2.6 Firewall (opcional pero habitual en lab)

En **todos los nodos** (master + workers), si usas `firewalld`:

```bash
# Prometheus UI
firewall-cmd --add-port=30900/tcp --permanent
# Grafana UI
firewall-cmd --add-port=30300/tcp --permanent
# JeanOS frontend (referencia)
firewall-cmd --add-port=30080/tcp --permanent
# Node Exporter scrape desde Prometheus
firewall-cmd --add-port=9100/tcp --permanent
firewall-cmd --reload
```

---

## 3. Orden de despliegue (desde el master)

Variables:

```bash
cd JeanOS
M="$(pwd)/ansible-k8s/manifests/monitoring"
```

### Paso 1 — Namespace `monitoring`

PSA **privileged** (necesario para que Promtail lea `/var/log` del host).

```bash
kubectl apply -f "${M}/namespace.yaml"
kubectl get namespace monitoring --show-labels
```

### Paso 2 — Node Exporter (un pod por nodo)

```bash
kubectl apply -f "${M}/node-exporter/daemonset.yaml"
kubectl get pods -n monitoring -l app=node-exporter -o wide
```

En cada nodo debe aparecer un pod `Running`. Prueba desde el master:

```bash
curl -s http://192.168.41.154:9100/metrics | head -5
```

### Paso 3 — kube-state-metrics

```bash
kubectl apply -f "${M}/prometheus/kube-state-metrics-rbac.yaml"
kubectl apply -f "${M}/prometheus/kube-state-metrics-deployment.yaml"
kubectl apply -f "${M}/prometheus/kube-state-metrics-service.yaml"
kubectl wait --for=condition=available deployment/kube-state-metrics -n monitoring --timeout=120s
```

### Paso 4 — Loki

```bash
kubectl apply -f "${M}/loki/configmap.yaml"
kubectl apply -f "${M}/loki/pvc.yaml"
kubectl apply -f "${M}/loki/deployment.yaml"
kubectl apply -f "${M}/loki/service.yaml"
kubectl wait --for=condition=available deployment/loki -n monitoring --timeout=300s
kubectl get pvc -n monitoring loki-pvc
```

El PVC debe quedar **Bound**.

### Paso 5 — Tempo (trazas)

Almacenamiento en `emptyDir` (el WAL de Tempo no conviene en NFS). Expone OTLP en el cluster para futura instrumentación del backend.

```bash
kubectl apply -f "${M}/tempo/configmap.yaml"
kubectl apply -f "${M}/tempo/deployment.yaml"
kubectl apply -f "${M}/tempo/service.yaml"
kubectl wait --for=condition=available deployment/tempo -n monitoring --timeout=300s
kubectl exec -n monitoring deploy/tempo -- wget -qO- http://localhost:3200/ready
```

Endpoints internos:

| Protocolo | Servicio:puerto |
|-----------|-----------------|
| Query / métricas Tempo | `tempo.monitoring.svc:3200` |
| OTLP gRPC | `tempo.monitoring.svc:4317` |
| OTLP HTTP | `tempo.monitoring.svc:4318` |

### Paso 6 — Promtail

```bash
kubectl apply -f "${M}/promtail/rbac.yaml"
kubectl apply -f "${M}/promtail/configmap.yaml"
kubectl apply -f "${M}/promtail/daemonset.yaml"
kubectl get pods -n monitoring -l app=promtail -o wide
```

### Paso 7 — Prometheus

```bash
kubectl apply -f "${M}/prometheus/rbac.yaml"
kubectl apply -f "${M}/prometheus/pvc.yaml"
kubectl apply -f "${M}/prometheus/configmap.yaml"
kubectl apply -f "${M}/prometheus/deployment.yaml"
kubectl apply -f "${M}/prometheus/service.yaml"
kubectl wait --for=condition=available deployment/prometheus -n monitoring --timeout=300s
kubectl get pvc -n monitoring prometheus-pvc
```

### Paso 8 — Grafana

```bash
kubectl apply -f "${M}/grafana/pvc.yaml"
kubectl apply -f "${M}/grafana/datasources-configmap.yaml"
kubectl apply -f "${M}/grafana/deployment.yaml"
kubectl apply -f "${M}/grafana/service.yaml"
kubectl wait --for=condition=available deployment/grafana -n monitoring --timeout=300s
```

Si Grafana no puede escribir en NFS, en el servidor NFS (master):

```bash
chown -R 472:472 /srv/nfs/dynamic/monitoring
# o el subpath que cree el provisioner para grafana-pvc
kubectl rollout restart deployment/grafana -n monitoring
```

### Aplicar solo el stack de monitoreo (bloque resumido)

```bash
cd JeanOS
M=ansible-k8s/manifests/monitoring

kubectl apply -f $M/namespace.yaml
kubectl apply -R -f $M/node-exporter/
kubectl apply -f $M/prometheus/kube-state-metrics-rbac.yaml
kubectl apply -f $M/prometheus/kube-state-metrics-deployment.yaml
kubectl apply -f $M/prometheus/kube-state-metrics-service.yaml
kubectl apply -R -f $M/loki/
kubectl apply -R -f $M/tempo/
kubectl apply -R -f $M/promtail/
kubectl apply -f $M/prometheus/rbac.yaml -f $M/prometheus/pvc.yaml
kubectl apply -f $M/prometheus/configmap.yaml -f $M/prometheus/deployment.yaml -f $M/prometheus/service.yaml
kubectl apply -R -f $M/alertmanager/
kubectl apply -f $M/grafana/pvc.yaml -f $M/grafana/datasources-configmap.yaml
kubectl apply -R -f $M/grafana/
```

> **Orden crítico:** Loki antes de Promtail; **Tempo antes de Grafana** (datasources referencian `tempo.monitoring.svc`); Prometheus después de Loki/Tempo si quieres targets `tempo` y `jeanos-backend` UP de inmediato. Alertmanager antes (o junto) que Prometheus para que el target `alertmanager` y el envío de alertas queden UP.

---

## 4. Validación en el master

### Estado general

```bash
kubectl get all,pvc -n monitoring
```

Esperado: `node-exporter` (N pods = N nodos), `promtail` (idem), `prometheus`, `grafana`, `loki`, `tempo`, `kube-state-metrics` en **Running**; PVCs **Bound** (Tempo usa `emptyDir`, sin PVC).

### Prometheus — targets

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
echo "Prometheus: http://${NODE_IP}:30900"
```

En el navegador: **Status → Targets**. Deben estar **UP**:

- `prometheus`
- `node-exporter` (una entrada por IP de nodo)
- `kube-state-metrics`
- `jeanos-backend` (si `jeanos-shop` está desplegado)
- `tempo`

O por línea de comandos:

```bash
kubectl port-forward -n monitoring svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=up{job="jeanos-backend"}'
curl -s 'http://localhost:9090/api/v1/query?query=up{job="tempo"}'
curl -s 'http://localhost:9090/api/v1/query?query=jeanos_http_requests_total' | head -c 400
```

#### Jobs de scrape configurados

| Job | Target | Qué aporta |
|-----|--------|------------|
| `node-exporter` | IPs nodos `:9100` | CPU, RAM, disco (hardware) |
| `kube-state-metrics` | `kube-state-metrics.monitoring.svc:8080` | Estado pods/deployments |
| `jeanos-backend` | `jeanos-backend-service.jeanos-shop.svc:3000` | Métricas `jeanos_*` de la API |
| `tempo` | `tempo.monitoring.svc:3200` | Métricas internas del ingester Tempo |
| `kubernetes-pods-annotated` | Pods con anotación `prometheus.io/scrape` | Backend si tiene anotaciones en el Deployment |

### Tempo

```bash
kubectl get pods -n monitoring -l app=tempo
kubectl logs -n monitoring deploy/tempo --tail=30
kubectl exec -n monitoring deploy/tempo -- wget -qO- http://localhost:3200/ready
kubectl exec -n monitoring deploy/tempo -- wget -qO- http://localhost:3200/metrics | head -20
```

Comprobar Service:

```bash
kubectl get svc tempo -n monitoring
# tempo.monitoring.svc:3200  (query)
# tempo.monitoring.svc:4317  (OTLP gRPC)
# tempo.monitoring.svc:4318  (OTLP HTTP)
```

En Grafana, verifica que existan **tres** datasources: Prometheus (default), Loki, Tempo.

```bash
kubectl exec -n monitoring deploy/grafana -- \
  wget -qO- http://tempo.monitoring.svc:3200/ready
```

### Grafana

```bash
echo "Grafana: http://${NODE_IP}:30300"
echo "Usuario: admin  Contraseña: jeanos2026"
```

1. **Explore → Prometheus** → `up{job="jeanos-backend"}` y métricas `jeanos_*`
2. **Explore → Loki** → `{namespace="jeanos-shop"}`
3. **Explore → Tempo** — búsqueda de trazas; desde una traza: **Metrics** (enlaza a Prometheus) y **Logs** (enlaza a Loki)
4. **Dashboards → Import → ID `1860`** (Node Exporter Full — hardware/nodos)

**Tempo en Grafana (paso a paso):**

1. Menú **Explore** → datasource **Tempo**.
2. Pestaña **Search** → Run query (puede estar vacío sin OTLP en la app).
3. Con trazas visibles: abrir una traza → botón **Metrics** (abre Prometheus en el rango de la traza) o **Logs** (abre Loki).
4. Datasource **Prometheus** → consultas `jeanos_*` para la tienda (no confundir con trazas).

Las trazas de JeanOS aparecen cuando el backend envía OTLP a `tempo.monitoring.svc:4317`. Sin instrumentación, usa Tempo para validar el stack y `up{job="tempo"}` en Prometheus.

### Generar tráfico para métricas

```bash
curl -s "http://${NODE_IP}:30080/api/products"
curl -s -X POST "http://${NODE_IP}:30080/api/compare" \
  -H "Content-Type: application/json" -d '{"ids":[1,2]}'
```

Vuelve a consultar en Prometheus/Grafana:

```promql
sum(rate(jeanos_http_requests_total[5m])) by (route)
sum(rate(jeanos_cache_hits_total[5m])) by (route)
```

### Loki y logs de la tienda

```bash
kubectl exec -n monitoring deploy/loki -- wget -qO- http://localhost:3100/ready
kubectl logs -n monitoring -l app=promtail --tail=15
```

En Grafana (Loki):

```logql
{namespace="jeanos-shop"}
{namespace="jeanos-shop", container="backend"}
{namespace="jeanos-shop", container="preload-redis"}
```

---

## 5. Actualizar configuración sin redeploy completo

| Cambio | Acción en el master |
|--------|---------------------|
| IPs node-exporter | Editar `prometheus/configmap.yaml` → `kubectl apply` → `kubectl rollout restart deployment/prometheus -n monitoring` |
| Código backend / métricas | `docker build` + `push` → `kubectl rollout restart deployment/jeanos-backend -n jeanos-shop` |
| Datasources Grafana (Tempo/Loki/Prometheus) | Editar `grafana/datasources-configmap.yaml` → `apply` → `rollout restart deployment/grafana -n monitoring` |
| Solo Tempo | `kubectl apply -f tempo/` → `rollout restart deployment/tempo -n monitoring` |

---

## 6. Port-forward (si NodePort no es accesible)

Desde el master:

```bash
kubectl port-forward -n monitoring svc/prometheus 9090:9090
kubectl port-forward -n monitoring svc/grafana 3000:3000
kubectl port-forward -n monitoring svc/tempo 3200:3200
kubectl port-forward -n jeanos-shop svc/jeanos-backend-service 3000:3000
```

Tempo query API local: `http://localhost:3200/ready` y `http://localhost:3200/metrics`

---

## 7. Troubleshooting rápido

### PVC en `Pending`

```bash
kubectl describe pvc -n monitoring
kubectl get storageclass nfs-client
kubectl get pods -n nfs-provisioner
kubectl get events -n monitoring --sort-by='.lastTimestamp' | tail -20
```

### Target `node-exporter` DOWN

- Pod del DaemonSet no Running: `kubectl get pods -n monitoring -l app=node-exporter -o wide`
- IP incorrecta en ConfigMap
- Firewall bloquea 9100: `curl http://<IP-NODO>:9100/metrics`

### Target `jeanos-backend` DOWN

```bash
kubectl get endpoints jeanos-backend-service -n jeanos-shop
kubectl get pods -n jeanos-shop -l app=jeanos-backend
kubectl logs -n jeanos-shop -l app=jeanos-backend -c backend --tail=30
```

Rebuild de imagen si `/metrics` devuelve 404.

### Promtail sin logs en Loki

```bash
kubectl describe pod -n monitoring -l app=promtail | tail -30
kubectl get namespace monitoring --show-labels | grep pod-security
```

Debe tener `pod-security.kubernetes.io/enforce=privileged`.

### Grafana “Data source not working”

URLs internas correctas (no `localhost`):

| Datasource | URL |
|------------|-----|
| Prometheus | `http://prometheus.monitoring.svc:9090` |
| Loki | `http://loki.monitoring.svc:3100` |
| Tempo | `http://tempo.monitoring.svc:3200` |

```bash
kubectl exec -n monitoring deploy/grafana -- \
  wget -qO- http://prometheus.monitoring.svc:9090/-/healthy
kubectl exec -n monitoring deploy/grafana -- \
  wget -qO- http://loki.monitoring.svc:3100/ready
kubectl exec -n monitoring deploy/grafana -- \
  wget -qO- http://tempo.monitoring.svc:3200/ready
```

Si falta Tempo en Grafana: reaplica `grafana/datasources-configmap.yaml` y `kubectl rollout restart deployment/grafana -n monitoring`.

### Tempo en CrashLoopBackOff o Not Ready

```bash
kubectl describe pod -n monitoring -l app=tempo
kubectl logs -n monitoring deploy/tempo --tail=50
```

No montes el WAL de Tempo en PVC NFS; el manifiesto del repo usa `emptyDir`. Si cambiaste a NFS y falla, vuelve al `deployment.yaml` del repo.

### Target `tempo` DOWN en Prometheus

```bash
kubectl get endpoints tempo -n monitoring
kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- http://tempo.monitoring.svc:3200/ready
```

Tras editar `prometheus/configmap.yaml`, reinicia Prometheus.

---

## 8. Qué no despliega esta guía

| Componente | Ubicación en repo | Cuándo |
|------------|-------------------|--------|
| **OpenTelemetry en el backend** | — | Opcional; sin OTLP las trazas en Tempo estarán vacías (métricas `jeanos_*` siguen en Prometheus) |
| **Alertmanager** | `ansible-k8s/manifests/monitoring/alertmanager/` | Operativo (reglas en `prometheus/configmap.yaml` → `alert.rules.yml`) |
| **Tekton / ArgoCD** | `examples/tekton-argocd/` | Semana 4 |
| **nfs-csi** | `examples/storageclass-nfs-csi/` | No necesario si usas `nfs-client` |

---

## 9. Referencias en el repo

| Documento | Contenido |
|-----------|-----------|
| `ansible-k8s/manifests/monitoring/README.md` | Detalle técnico del stack |
| `ansible-k8s/deploy-jeanos.sh` | Despliegue de la tienda |
| `docs/evidencias/README.md` | Recoger evidencias post-despliegue |
| `examples/monitoring/` | Material de referencia del bootcamp (no borrar) |
| `examples/07-tempo.yaml` | Referencia original de Tempo |
| `ansible-k8s/manifests/monitoring/tempo/` | Manifiestos Tempo usados en el despliegue |

---

## 10. Checklist resumido (master)

- [ ] `kubectl get nodes` — todos Ready  
- [ ] `storageclass nfs-client` + provisioner Running  
- [ ] `jeanos-shop` desplegado; `/metrics` responde  
- [ ] IPs en `prometheus/configmap.yaml` actualizadas  
- [ ] Namespace + node-exporter + kube-state-metrics  
- [ ] Loki + Tempo + Promtail  
- [ ] Prometheus + Grafana; PVCs Bound  
- [ ] Targets UP en `:30900` (incl. `jeanos-backend`, `tempo`)  
- [ ] Grafana `:30300` — Prometheus + Loki + Tempo OK  
- [ ] Logs `{namespace="jeanos-shop"}` en Loki  
- [ ] Explore Tempo con correlación a Prometheus  
