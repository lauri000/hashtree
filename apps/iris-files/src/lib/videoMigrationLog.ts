export interface VideoMigrationLogEvent {
  tool: 'video-migration';
  kind: string;
  at: string;
  payload: Record<string, unknown>;
}

function sanitizeLogValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      type: 'Uint8Array',
      length: value.length,
      hexPrefix: Array.from(value.slice(0, 8)).map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeLogValue(item)]),
    );
  }
  if (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || value === null
  ) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  return String(value);
}

export function createVideoMigrationLogEvent(
  kind: string,
  payload: Record<string, unknown> = {},
): VideoMigrationLogEvent {
  return {
    tool: 'video-migration',
    kind,
    at: new Date().toISOString(),
    payload: sanitizeLogValue(payload) as Record<string, unknown>,
  };
}

export function logVideoMigrationEvent(
  kind: string,
  payload: Record<string, unknown> = {},
): VideoMigrationLogEvent {
  const event = createVideoMigrationLogEvent(kind, payload);
  console.info('[video-migration]', event);

  if (import.meta.env.DEV && typeof fetch === 'function') {
    void fetch('/__video_migration_log', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {});
  }

  return event;
}
