#!/usr/bin/env bash
# Redeploy JeanOS Shop (hardware catalog) usando redeploy.env
# Uso:
#   cp redeploy.env.example redeploy.env   # primera vez; edita REGISTRY y credenciales
#   ./redeploy-jeanos.sh
#   ./redeploy-jeanos.sh --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ENV_FILE="${REDEPLOY_ENV:-${SCRIPT_DIR}/redeploy.env}"
MANIFESTS="${SCRIPT_DIR}/manifests"
SEED_SQL="${SEED_SQL:-${SCRIPT_DIR}/seed-productos.sql}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      cat <<'EOF'
Uso: redeploy-jeanos.sh [--dry-run]

Lee ansible-k8s/redeploy.env (o REDEPLOY_ENV) y ejecuta:
  build/push imágenes → seed SQL → apply manifests → rollout → smoke tests

Variables útiles (redeploy.env o entorno):
  REPO_ROOT, SEED_SQL, REGISTRY, IMAGE_TAG, BUILD_PLATFORM, BUILD_SCRIPT
  K8S_NAMESPACE, POSTGRES_POD, KUBECONFIG

Semana 4 (GitOps): Tekton hace el build; deja BUILD_IMAGES=false y haz git push.
Si aplicas manifests a mano con ArgoCD auto-sync ON, usa PAUSE_ARGOCD_SYNC=true
o push de manifests al repo remoto.
EOF
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg" >&2
      exit 1
      ;;
  esac
done

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Falta comando: $1" >&2
    exit 1
  }
}

bool() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_container_builder() {
  if [[ -n "${CONTAINER_BUILDER:-}" ]]; then
    echo "$CONTAINER_BUILDER"
    return
  fi
  if command -v podman >/dev/null 2>&1; then
    echo podman
  elif command -v docker >/dev/null 2>&1; then
    echo docker
  else
    echo ""
  fi
}

resolve_node_ip() {
  local ip=""
  ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[0].address}' 2>/dev/null || true)"
  fi
  echo "$ip"
}

wait_postgres_ready() {
  local ns="$1" pod="$2" user="$3" db="$4"
  local timeout="${POSTGRES_READY_TIMEOUT:-120}"
  local elapsed=0

  log "Esperando PostgreSQL (${ns}/${pod})"
  while (( elapsed < timeout )); do
    if kubectl get pod -n "$ns" "$pod" >/dev/null 2>&1 \
      && kubectl exec -n "$ns" "$pod" -- pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo "PostgreSQL no respondió en ${timeout}s (${ns}/${pod})." >&2
  echo "Revisa: kubectl get pods -n ${ns} && kubectl logs -n ${ns} ${pod}" >&2
  return 1
}

run_seed_sql() {
  local ns="$1" pod="$2" user="$3" db="$4" seed_file="$5"

  if [[ ! -f "$seed_file" ]]; then
    echo "No existe el seed SQL: ${seed_file}" >&2
    exit 1
  fi

  log "Seed SQL → ${ns}/${pod} (${seed_file##*/})"
  wait_postgres_ready "$ns" "$pod" "$user" "$db"

  if $DRY_RUN; then
    echo "[dry-run] kubectl exec -i -n ${ns} ${pod} -- psql < ${seed_file}"
    return 0
  fi

  kubectl exec -i -n "$ns" "$pod" -- \
    psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" < "$seed_file"

  local counts
  counts="$(kubectl exec -n "$ns" "$pod" -- psql -U "$user" -d "$db" -At -c "
    SELECT COUNT(*) FROM clases_producto;
    SELECT COUNT(*) FROM productos;
    SELECT COUNT(*) FROM spec_definitions;
    SELECT COUNT(*) FROM producto_specs;
  ")"

  local clases productos spec_defs producto_specs
  clases="$(echo "$counts" | sed -n '1p')"
  productos="$(echo "$counts" | sed -n '2p')"
  spec_defs="$(echo "$counts" | sed -n '3p')"
  producto_specs="$(echo "$counts" | sed -n '4p')"

  log "Conteos catálogo: clases=${clases} productos=${productos} spec_definitions=${spec_defs} producto_specs=${producto_specs}"

  if [[ "${clases:-0}" -lt 5 || "${productos:-0}" -lt 25 || "${spec_defs:-0}" -lt 25 || "${producto_specs:-0}" -lt 125 ]]; then
    echo "Seed incompleto tras ejecutar ${seed_file}." >&2
    echo "Si quedó a medias por un error anterior, borra tablas y vuelve a lanzar:" >&2
    echo "  kubectl exec -n ${ns} ${pod} -- psql -U ${user} -d ${db} -c \\" >&2
    echo "    \"DROP TABLE IF EXISTS producto_specs, spec_definitions, productos, clases_producto CASCADE;\"" >&2
    exit 1
  fi
}

build_images_local() {
  local builder="$1"
  local platform="${BUILD_PLATFORM:-linux/amd64}"
  local registry="$2"
  local tag="$3"
  local back_name="$4"
  local front_name="$5"

  if bool "${PUSH_IMAGES:-true}"; then
    local registry_host="${registry%%/*}"
    if ! "${builder}" login --get-login "${registry_host}" >/dev/null 2>&1; then
      echo "Sin sesión en ${registry_host}. Ejecuta: ${builder} login ${registry_host}" >&2
      exit 1
    fi
  fi

  build_one() {
    local context="$1"
    local name="$2"
    local image="${registry}/${name}:${tag}"
    log "Build ${image} (${platform})"
    run "${builder}" build --platform "${platform}" -t "${image}" "${context}"
    if bool "${PUSH_IMAGES:-true}"; then
      run "${builder}" push "${image}"
    fi
  }

  build_one "${REPO_ROOT}/app/backend" "${back_name}"
  build_one "${REPO_ROOT}/app/frontend" "${front_name}"
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No existe ${ENV_FILE}." >&2
  echo "Copia redeploy.env.example → redeploy.env y edita REGISTRY (tu usuario Docker Hub)." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

NS="${K8S_NAMESPACE:-jeanos-shop}"
PG_POD="${POSTGRES_POD:-postgres-0}"
PG_USER="${POSTGRES_USER:-jeanosadmin}"
PG_DB="${POSTGRES_DB:-jeanosdb}"
REGISTRY="${REGISTRY:-}"
TAG="${IMAGE_TAG:-v1}"
BACK_NAME="${DOCKER_BACKEND_IMAGE:-jeanos-backend}"
FRONT_NAME="${DOCKER_FRONTEND_IMAGE:-jeanos-frontend}"
NODE_PORT="${FRONTEND_NODE_PORT:-30080}"
CMP_ID_1="${COMPARE_ID_1:-1}"
CMP_ID_2="${COMPARE_ID_2:-2}"
CMP_ID_3="${COMPARE_ID_3:-3}"
CLASS_FILTER="${PRODUCTS_CLASS_FILTER:-gpu}"
SEED_SQL="${SEED_SQL:-${SCRIPT_DIR}/seed-productos.sql}"
BUILD_SCRIPT="${BUILD_SCRIPT:-}"

BUILD_IMAGES="${BUILD_IMAGES:-false}"
PUSH_IMAGES="${PUSH_IMAGES:-true}"
RUN_SEED="${RUN_SEED:-true}"
APPLY_MANIFESTS="${APPLY_MANIFESTS:-false}"
RESTART_DEPLOYMENTS="${RESTART_DEPLOYMENTS:-true}"
WAIT_ROLLOUT="${WAIT_ROLLOUT:-true}"
RUN_SMOKE_TESTS="${RUN_SMOKE_TESTS:-true}"
SHOW_INIT_LOGS="${SHOW_INIT_LOGS:-true}"
PAUSE_ARGOCD_SYNC="${PAUSE_ARGOCD_SYNC:-false}"
ARGOCD_APP="${ARGOCD_APP_NAME:-jeanos-shop-gitops}"
ARGOCD_NS="${ARGOCD_NAMESPACE:-argocd}"

need_cmd kubectl

if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "kubectl no puede contactar el cluster. Revisa KUBECONFIG y el contexto activo." >&2
  exit 1
fi

if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  echo "Namespace ${NS} no existe. Ejecuta primero ./deploy-jeanos.sh en el cluster." >&2
  exit 1
fi

log "JeanOS redeploy"
log "Env: ${ENV_FILE}"
log "Repo: ${REPO_ROOT}"
log "Namespace: ${NS}"
log "Imágenes: ${REGISTRY:-<sin REGISTRY>}/${BACK_NAME}:${TAG} · ${REGISTRY:-<sin REGISTRY>}/${FRONT_NAME}:${TAG}"

if bool "$PAUSE_ARGOCD_SYNC"; then
  if kubectl get application "$ARGOCD_APP" -n "$ARGOCD_NS" >/dev/null 2>&1; then
    log "Pausando auto-sync ArgoCD (${ARGOCD_NS}/${ARGOCD_APP})"
    run kubectl patch application "$ARGOCD_APP" -n "$ARGOCD_NS" --type merge \
      -p '{"spec":{"syncPolicy":{"automated":null}}}'
  else
    log "Aviso: Application ArgoCD no encontrada; omitiendo pausa sync"
  fi
fi

if bool "$BUILD_IMAGES"; then
  if [[ -z "$REGISTRY" ]]; then
    echo "BUILD_IMAGES=true requiere REGISTRY en redeploy.env (ej. docker.io/tu_usuario)." >&2
    exit 1
  fi

  if [[ -n "$BUILD_SCRIPT" && -x "$BUILD_SCRIPT" ]]; then
    log "Build imágenes vía BUILD_SCRIPT (${BUILD_SCRIPT})"
    run env REGISTRY="$REGISTRY" TAG="$TAG" PLATFORM="${BUILD_PLATFORM:-linux/amd64}" \
      DOCKER_BACKEND_IMAGE="$BACK_NAME" DOCKER_FRONTEND_IMAGE="$FRONT_NAME" \
      "$BUILD_SCRIPT"
  elif [[ -n "$BUILD_SCRIPT" && -f "$BUILD_SCRIPT" ]]; then
    log "Build imágenes vía BUILD_SCRIPT (${BUILD_SCRIPT})"
    run env REGISTRY="$REGISTRY" TAG="$TAG" PLATFORM="${BUILD_PLATFORM:-linux/amd64}" \
      DOCKER_BACKEND_IMAGE="$BACK_NAME" DOCKER_FRONTEND_IMAGE="$FRONT_NAME" \
      bash "$BUILD_SCRIPT"
  else
    local_builder="$(resolve_container_builder)"
    if [[ -z "$local_builder" ]]; then
      echo "BUILD_IMAGES=true pero no hay podman/docker. Instala uno o define BUILD_SCRIPT." >&2
      exit 1
    fi
    log "Build imágenes (${local_builder}, ${BUILD_PLATFORM:-linux/amd64})"
    build_images_local "$local_builder" "$REGISTRY" "$TAG" "$BACK_NAME" "$FRONT_NAME"
  fi
else
  log "Build omitido (BUILD_IMAGES=false) — usa Tekton o build manual"
fi

if bool "$RUN_SEED"; then
  if ! kubectl get pod -n "$NS" "$PG_POD" >/dev/null 2>&1; then
    echo "Pod PostgreSQL ${NS}/${PG_POD} no encontrado. Ajusta POSTGRES_POD en redeploy.env." >&2
    exit 1
  fi
  run_seed_sql "$NS" "$PG_POD" "$PG_USER" "$PG_DB" "$SEED_SQL"
else
  log "Seed omitido (RUN_SEED=false)"
fi

if bool "$APPLY_MANIFESTS"; then
  log "Apply manifests backend + frontend"
  run kubectl apply -f "${MANIFESTS}/backend/backend-service.yaml"
  run kubectl apply -f "${MANIFESTS}/backend/backend-deployment.yaml"
  run kubectl apply -f "${MANIFESTS}/frontend/frontend-service.yaml"
  run kubectl apply -f "${MANIFESTS}/frontend/frontend-deployment.yaml"
else
  log "Apply manifests omitido (APPLY_MANIFESTS=false) — ArgoCD sincroniza desde Git"
fi

if bool "$RESTART_DEPLOYMENTS"; then
  log "Rollout restart backend + frontend"
  run kubectl rollout restart deployment/jeanos-backend -n "$NS"
  run kubectl rollout restart deployment/jeanos-frontend -n "$NS"
fi

if bool "$WAIT_ROLLOUT"; then
  log "Esperando rollouts"
  run kubectl rollout status deployment/jeanos-backend -n "$NS" --timeout=300s
  run kubectl rollout status deployment/jeanos-frontend -n "$NS" --timeout=300s
fi

log "Estado pods y services"
run kubectl get pods,svc -n "$NS" -o wide

if bool "$SHOW_INIT_LOGS"; then
  POD="$(kubectl get pods -n "$NS" -l app=jeanos-backend -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "$POD" ]]; then
    log "Logs init (${POD})"
    run kubectl logs -n "$NS" "$POD" -c wait-for-postgres --tail=40 || true
    run kubectl logs -n "$NS" "$POD" -c preload-redis --tail=60 || true
    run kubectl logs -n "$NS" "$POD" -c backend --tail=30 || true
  fi
fi

if bool "$RUN_SMOKE_TESTS" && ! $DRY_RUN; then
  log "Smoke tests dentro del cluster"
  kubectl run -n "$NS" "jeanos-smoke-$RANDOM" --rm -i --restart=Never \
    --image=curlimages/curl:8.5.0 -- \
    sh -c "
      set -e
      curl -sf http://jeanos-backend-service:3000/healthz >/dev/null
      curl -sf http://jeanos-backend-service:3000/readyz >/dev/null
      curl -sf http://jeanos-backend-service:3000/api/classes | head -c 200
      echo ''
      curl -sf 'http://jeanos-backend-service:3000/api/products?class=${CLASS_FILTER}' | head -c 300
      echo ''
      curl -sf -X POST http://jeanos-backend-service:3000/api/compare \
        -H 'Content-Type: application/json' \
        -d '{\"ids\":[${CMP_ID_1},${CMP_ID_2},${CMP_ID_3}]}' | head -c 400
      echo ''
      curl -sf http://jeanos-frontend-service/api/classes | head -c 200
      echo ''
    "

  NODE_IP="${NODE_IP:-$(resolve_node_ip)}"
  if [[ -n "$NODE_IP" ]]; then
    log "Smoke tests NodePort http://${NODE_IP}:${NODE_PORT}"
    if command -v curl >/dev/null 2>&1; then
      curl -sf "http://${NODE_IP}:${NODE_PORT}/api/classes" | head -c 200 || echo "NodePort curl falló"
      echo ""
      echo "UI: http://${NODE_IP}:${NODE_PORT}/"
    else
      echo "UI (sin curl local): http://${NODE_IP}:${NODE_PORT}/"
    fi
  else
    log "Aviso: no se pudo resolver NODE_IP; define NODE_IP en redeploy.env para pruebas NodePort"
  fi
fi

log "Redeploy completado"
if bool "$PAUSE_ARGOCD_SYNC"; then
  echo ""
  echo "Recuerda: reactiva ArgoCD sync o haz git push de manifests para alinear GitOps."
fi
