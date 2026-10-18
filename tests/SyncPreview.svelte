<script lang="ts">
  /** 同步页面的真实组件及版本引擎；只替换网络和文件端口，覆盖状态与响应式布局。 */
  import { onMount } from 'svelte';
  import SyncPanel from '../src/lib/SyncPanel.svelte';
  import { SyncEngine } from '../src/lib/sync/engine';
  import { SyncController } from '../src/lib/sync/controller';
  import type { DocumentContent, SyncTransport } from '../src/lib/sync/contracts';
  const params = new URLSearchParams(location.search);
  const scenario = params.get('case') ?? 'paired';
  const projects = Array.from({ length: params.has('long') ? 30 : 3 }, (_, i) => ({ id: `local-${i}`, name: ['工作清单', '产品设计笔记', '旅行计划'][i] ?? `项目 ${i + 1}` }));
  let version = $state(0); let ready = $state(false);
  const content = new Map<string, DocumentContent>(projects.map(project => [project.id, { text: '# 工作清单\n\n整理本周的设计反馈。\n', name: project.name, archived: false }]));
  content.set('inspiration', { text: '一个新想法', name: '灵感', archived: false });
  const engine = new SyncEngine({ read: async id => content.get(id)!, apply: async (id, _, next) => { content.set(id, next); }, accept: async () => null }, { load: async () => null, save: async () => {} }, () => version++);
  const transport: SyncTransport = {
    status: async () => ({ paired: scenario !== 'unpaired', listening: !params.has('mobile'), session: 'preview' }),
    offer: async () => ({ version: 1, address: '192.168.31.156:50736', addresses: ['192.168.31.156:50736', '192.168.137.2:50736'], token: '0'.repeat(64), certificate: Array.from({ length: 400 }, (_, i) => i % 256), expires: Date.now() / 1000 + 300 }),
    pair: async () => false, approve: async () => {}, unpair: async () => {}, probe: async () => {}, exchange: async value => value, respond: async () => {}, address: async () => {},
    notify: async () => {}, disconnect: async () => {},
  };
  const controller = new SyncController(engine, transport, !params.has('mobile'), () => version++);
  onMount(() => { void (async () => {
    await engine.load(); await engine.attachPairing('preview'); controller.connection = await transport.status(); controller.status = scenario === 'unpaired' ? '未配对' : '已同步';
    if (scenario !== 'unpaired') {
      const id = await engine.enable('local-0', 'project'); await engine.enable('local-1', 'project');
      const acknowledged = await engine.offer(); acknowledged.selection!.revision = 0; await engine.receive(acknowledged);
      if (scenario === 'conflict') {
        const other = new SyncEngine({ read: async () => ({ text: '# 工作清单\n\n手机整理后的设计反馈。\n', name: '工作清单', archived: false }), apply: async () => {}, accept: async () => 'remote' }, { load: async () => null, save: async () => {} });
        await other.load(); await other.receive(await engine.offer()); await other.accept(id); await engine.receive(await other.offer()); controller.status = '有同步冲突';
      }
      if (scenario === 'incoming') {
        const other = new SyncEngine({ read: async () => ({ text: '新文档', name: '手机上的新项目', archived: false }), apply: async () => {}, accept: async () => null }, { load: async () => null, save: async () => {} });
        await other.load(); const incomingId = await other.enable('new', 'project'); await engine.receive(await other.offer()); controller.status = '有待接收文档';
        window.addEventListener('withdraw-preview', () => { void (async () => { await other.disable(incomingId); await engine.receive(await other.offer()); })(); }, { once: true });
      }
      if (scenario === 'error') { controller.error = '无法连接电脑，请确认两端连接同一局域网。'; controller.status = '等待同步'; }
    }
    ready = true;
  })(); return () => controller.stop(); });
</script>
{#if ready}<SyncPanel {controller} revision={version} {projects} ensureInspiration={async () => {}} focus={() => ({ destroy() {} })} onClose={() => {}}/>{/if}
