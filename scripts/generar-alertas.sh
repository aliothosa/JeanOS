#!/usr/bin/env bash
# Dispara varias alertas de Prometheus/Alertmanager para la demo de JeanOS.
# Ejecutar en el master (donde tienes kubectl con acceso al cluster).
#
# Uso:
#   ./scripts/generar-alertas.sh            # dispara todas las alertas de demo
#   ./scripts/generar-alertas.sh restore    # restaura el estado normal y limpia
#   ./scripts/generar-alertas.sh status     # muestra alertas Pending/Firing
#
# Alertas que provoca:
#   - BackendDown (critical, ~1m)  -> escala backend a 0
#   - TargetDown  (warning,  ~2m)  -> targets caídos (backend)
#   - PodNotReady (warning,  ~5m)  -> pod con imagen inexistente
#   - NodeHighCpu (warning,  ~5m)  -> pod de stress de CPU
#   - PodHighMemoryUsage (warning, ~5m) -> pod de stress de memoria (>90% del límite)

set -euo pipefail

NS_APP="jeanos-shop"
NS_MON="monitoring"
BACKEND_DEPLOY="jeanos-backend"
BACKEND_REPLICAS="${BACKEND_REPLICAS:-2}"
STRESS_IMAGE="${STRESS_IMAGE:-progrium/stress}"
STRESS_SECONDS="${STRESS_SECONDS:-600}"

# Nombres de los pods efímeros que crea el script (para poder limpiarlos).
POD_BROKEN="alert-demo-broken"
POD_CPU="alert-demo-cpu"
POD_MEM="alert-demo-mem"

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }

need_kubectl() {
  command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl no está en el PATH"; exit 1; }
}

trigger() {
  c_blue "==> 1/4 BackendDown + TargetDown: escalando ${BACKEND_DEPLOY} a 0"
  kubectl scale deployment/"${BACKEND_DEPLOY}" -n "${NS_APP}" --replicas=0

  c_blue "==> 2/4 PodNotReady: pod con imagen inexistente"
  kubectl run "${POD_BROKEN}" -n "${NS_APP}" --image=does-not-exist:404 \
    --restart=Never --labels="app=alert-demo" >/dev/null 2>&1 || true

  c_blue "==> 3/4 NodeHighCpu: pod de stress de CPU (${STRESS_SECONDS}s)"
  kubectl run "${POD_CPU}" -n "${NS_APP}" --image="${STRESS_IMAGE}" \
    --restart=Never --labels="app=alert-demo" -- \
    --cpu 8 --timeout "${STRESS_SECONDS}s" >/dev/null 2>&1 || true

  c_blue "==> 4/4 PodHighMemoryUsage: pod de stress de memoria con límite bajo"
  kubectl run "${POD_MEM}" -n "${NS_APP}" --image="${STRESS_IMAGE}" \
    --restart=Never --labels="app=alert-demo" \
    --overrides='{"spec":{"containers":[{"name":"'"${POD_MEM}"'","image":"'"${STRESS_IMAGE}"'","args":["--vm","1","--vm-bytes","120M","--timeout","'"${STRESS_SECONDS}"'s"],"resources":{"limits":{"memory":"128Mi"}}}]}}' \
    >/dev/null 2>&1 || true

  echo
  c_green "Alertas en marcha. Tiempos de 'for':"
  echo "  BackendDown ~1m | TargetDown ~2m | PodNotReady/NodeHighCpu/PodHighMemoryUsage ~5m"
  echo
  c_yellow "Sigue el estado con:   $0 status"
  c_yellow "Restaura todo con:     $0 restore"
}

status() {
  c_blue "==> Alertas (Pending/Firing) según Prometheus"
  local pod
  pod="$(kubectl get pods -n "${NS_MON}" -l app=prometheus -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "${pod}" ]]; then
    echo "No encuentro el pod de Prometheus en ${NS_MON}."
    return 0
  fi
  # Consulta la API de Prometheus desde dentro del propio pod (sin port-forward).
  kubectl exec -n "${NS_MON}" "${pod}" -c prometheus -- \
    wget -qO- 'http://localhost:9090/api/v1/alerts' 2>/dev/null \
    | tr ',' '\n' | grep -E '"(alertname|state|severity)"' || \
    echo "Sin alertas activas todavía (o aún en evaluación)."
  echo
  c_blue "==> Pods de demo en ${NS_APP}"
  kubectl get pods -n "${NS_APP}" -l app=alert-demo 2>/dev/null || true
  kubectl get deployment/"${BACKEND_DEPLOY}" -n "${NS_APP}" 2>/dev/null || true
}

restore() {
  c_blue "==> Restaurando backend a ${BACKEND_REPLICAS} réplicas"
  kubectl scale deployment/"${BACKEND_DEPLOY}" -n "${NS_APP}" --replicas="${BACKEND_REPLICAS}"

  c_blue "==> Eliminando pods de demo"
  kubectl delete pod "${POD_BROKEN}" "${POD_CPU}" "${POD_MEM}" \
    -n "${NS_APP}" --ignore-not-found

  c_green "Estado normal restaurado. Las alertas pasarán a 'resolved' tras su intervalo."
}

main() {
  need_kubectl
  case "${1:-trigger}" in
    trigger|"") trigger ;;
    status)     status ;;
    restore)    restore ;;
    *) echo "Uso: $0 [trigger|status|restore]"; exit 1 ;;
  esac
}

main "$@"
