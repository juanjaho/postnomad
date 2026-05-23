import type { UID } from '../common';
import type { Request } from '../requests';
import type { Example } from './examples';
import type { FolderRoot } from './folder';

export type ItemType = 'http-request' | 'graphql-request' | 'folder' | 'js' | 'grpc-request' | 'ws-request';

export interface HttpItemSettings {
  encodeUrl?: boolean | null;
  followRedirects?: boolean | null;
  maxRedirects?: number | null;
  timeout?: number | 'inherit' | null;
  // Postnomad-only: per-request artificial latency before send.
  // Capped at 60s. Persisted in .bru format only (not opencollection YML).
  throttleMs?: number | null;
}

export interface WebSocketItemSettings {
  settings?: {
    timeout?: number | null;
    keepAliveInterval?: number | null;
  } | null;
}

export type ItemSettings = HttpItemSettings | WebSocketItemSettings | null;

export interface Item {
  uid: UID;
  type: ItemType;
  seq?: number | null;
  name: string;
  tags?: string[] | null;
  request?: Request | null;
  settings?: ItemSettings;
  fileContent?: string | null;
  root?: FolderRoot | null;
  items?: Item[] | null;
  examples?: Example[] | null;
  filename?: string | null;
  pathname?: string | null;
}
