/** 原生同步端口只暴露操作，不将长期设备凭证带入 WebView。 */
import { invoke } from '@tauri-apps/api/core';
import type { SyncStore, SyncTransport } from './contracts';
export const nativeSyncStore: SyncStore = {
  load: () => invoke('sync_load_state'),
  save: value => invoke('sync_save_state', { value }),
};
export const nativeSyncTransport: SyncTransport = {
  status: () => invoke('sync_status'), offer: () => invoke('sync_offer'),
  pair: offer => invoke('sync_pair', { offer }), approve: accept => invoke('sync_approve', { accept }),
  unpair: () => invoke('sync_unpair'), probe: async () => {
    await invoke('plugin:foldmark-mobile|activate');
    await invoke('sync_probe');
  },
  exchange: envelope => invoke('sync_exchange', { envelope }),
  notify: () => invoke('sync_notify'), disconnect: () => invoke('sync_disconnect'),
  respond: (id, envelope, error) => invoke('sync_respond', { id, envelope, error }),
  address: address => invoke('sync_address', { address }),
};
