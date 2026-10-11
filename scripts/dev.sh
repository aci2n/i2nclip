#!/bin/sh
# Persistent local PostgreSQL and the existing web/server image.
set -eu
cd "$(dirname "$0")/.."

network=i2nclip-dev
database=i2nclip-dev-postgres
volume=i2nclip-dev-postgres-data
server=i2nclip-dev-server
image=localhost/i2nclip-dev:latest
port=${DEV_PORT:-8080}
origin=${DEV_ORIGIN:-http://localhost:$port}

start_database() {
    if ! podman network exists "$network"; then
        podman network create "$network"
    fi
    if podman container exists "$database"; then
        podman start "$database" >/dev/null
    else
        podman run --detach --name "$database" \
            --network "$network" --network-alias db \
            --volume "$volume:/var/lib/postgresql" \
            --env POSTGRES_USER=i2nclip --env POSTGRES_DB=i2nclip \
            --env POSTGRES_PASSWORD=i2nclip-dev \
            --env POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
            docker.io/library/postgres:18
    fi
    attempts=0
    until podman exec --env PGPASSWORD=i2nclip-dev "$database" \
        psql --host=127.0.0.1 --username=i2nclip --dbname=i2nclip \
        --no-password --command='SELECT 1' >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 60 ]; then
            echo 'Development PostgreSQL did not become ready within 60 seconds.' >&2
            podman logs --tail 50 "$database" >&2 || true
            return 1
        fi
        sleep 1
    done
}

stop_server() {
    podman stop --time 10 "$server" >/dev/null 2>&1 || true
}

case "${1:-}" in
    dev)
        podman build \
            --tag "$image" --file Containerfile .
        start_database
        if podman container exists "$server"; then
            podman rm --force "$server" >/dev/null
        fi
        podman create --name "$server" --network "$network" \
            --publish "127.0.0.1:$port:8080" \
            --env "I2N_ORIGIN=$origin" \
            --env 'I2N_DATABASE_URL=postgresql://i2nclip:i2nclip-dev@db:5432/i2nclip?sslmode=disable' \
            "$image" >/dev/null
        trap stop_server EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        echo "Development server: $origin (host port $port)"
        podman start --attach --sig-proxy "$server"
        status=$(podman inspect --format '{{.State.ExitCode}}' "$server")
        exit "$status"
        ;;
    dev-db)
        start_database
        ;;
    dev-down)
        for container in "$server" "$database"; do
            if podman container exists "$container"; then
                podman stop --time 10 "$container" >/dev/null
            fi
        done
        ;;
    dev-otc)
        podman exec "$server" i2nclip otc issue
        ;;
    *)
        echo 'Usage: sh scripts/dev.sh dev|dev-db|dev-down|dev-otc' >&2
        exit 2
        ;;
esac
