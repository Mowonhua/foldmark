<script lang="ts">
  /** 同步页面的真实组件及版本引擎；只替换网络和文件端口，覆盖状态与响应式布局。 */
  import { onMount } from 'svelte';
  import SyncPanel from '../src/lib/SyncPanel.svelte';
  import { SyncEngine } from '../src/lib/sync/engine';
  import { SyncController } from '../src/lib/sync/controller';
  import type { DocumentContent, SyncTransport } from '../src/lib/sync/contracts';
  const params = new URLSearchParams(location.search);
  const scenario = params.get('case') ?? 'paired';
  // 归档项目用于验证同步清单筛选：local-1 已归档但仍在同步，旧项目已归档且未选择。
  const projects = [
    ...Array.from({ length: params.has('long') ? 30 : 3 }, (_, i) => ({ id: `local-${i}`, name: ['工作清单', '产品设计笔记', '旅行计划'][i] ?? `项目 ${i + 1}`, archived: i === 1 })),
    { id: 'archived', name: '旧项目', archived: true },
  ];
  let version = $state(0); let ready = $state(false);
  const content = new Map<string, DocumentContent>(projects.map(project => [project.id, { text: '# 工作清单\n\n整理本周的设计反馈。\n\n## 下周\n\n提交发布说明。\n', name: project.name, archived: project.archived ?? false }]));
  content.set('inspiration', { text: '一个新想法', name: '灵感', archived: false });
  // 两端各有独立正文：共用一份会让修改互相可见，构造不出真实的并发冲突。
  const peerContent = new Map<string, DocumentContent>([...content].map(([id, value]) => [id, { ...value }]));
  // 多处冲突场景需要更长的正文：下面两端各自改动其中三段，另有一处改动相同、一处新增任务。
  if (scenario === 'conflict-many') {
    const many = '# 工作清单\n\n整理本周的设计反馈。\n\n讨论下周的排期。\n\n- [ ] 甲\n- [ ] 乙\n\n## 下周\n\n提交发布说明。\n\n准备演示文稿。\n\n以上是本周重点。\n';
    content.set('local-0', { text: many, name: '工作清单', archived: false });
    peerContent.set('local-0', { text: many, name: '工作清单', archived: false });
  }
  const engine = new SyncEngine({ read: async id => content.get(id)!, apply: async (id, _, next) => { content.set(id, next); }, accept: async () => null }, { load: async () => null, save: async () => {} }, () => version++);
  const peer = new SyncEngine({ read: async id => peerContent.get(id)!, apply: async (id, _, next) => { peerContent.set(id, next); }, accept: async () => null }, { load: async () => null, save: async () => {} }, () => version++);
  const transport: SyncTransport = {
    status: async () => ({ paired: scenario !== 'unpaired', listening: !params.has('mobile'), session: 'preview' }),
    offer: async () => ({ version: 1, address: '192.168.31.156:50736', addresses: ['192.168.31.156:50736', '192.168.137.2:50736'], token: '0'.repeat(64), certificate: Array.from({ length: 400 }, (_, i) => i % 256), expires: Date.now() / 1000 + 300 }),
    pair: async () => false, approve: async () => {}, unpair: async () => {}, probe: async () => {}, exchange: async value => value, respond: async () => {}, address: async () => {},
    notify: async () => {}, disconnect: async () => {},
  };
  const controller = new SyncController(engine, transport, !params.has('mobile'), () => version++);
  onMount(() => { void (async () => {
    await engine.load(); await engine.attachPairing('preview');
    controller.connection = await transport.status();
    if (scenario === 'unpaired') { controller.status = '未配对'; ready = true; return; }
    await peer.load(); await peer.attachPairing('preview');
    // 先让两端共享同一基线再各自修改。伪造对端确认会让选择序号与版本基线脱节，引擎会以缺基线拒绝接收。
    const ids = [await engine.enable('local-0', 'project'), await engine.enable('local-1', 'project')];
    await peer.receive(await engine.offer());
    await peer.accept(ids[0], 'local-0'); await peer.accept(ids[1], 'local-1');
    await engine.receive(await peer.offer());
    controller.status = '已同步';
    if (scenario === 'conflict' || scenario === 'conflict-many') {
      // 两端同时改同一句（无法自动取舍），又各自在文末补充一段（两端可以并存）；
      // 多处冲突场景再各改两段：三段改动不同、一处改动相同、一端多出一条任务。
      const many = scenario === 'conflict-many';
      const sides: [string, string] = many
        ? ['# 工作清单\n\n本机整理后的设计反馈。\n\n本机讨论下周的排期。\n\n- [ ] 甲\n- [ ] 乙\n\n## 下周\n\n提交发布说明，附上更新日志。\n\n本机准备演示文稿。\n\n以上是本周重点。\n\n本机补充的说明。\n',
           '# 工作清单\n\n手机整理后的设计反馈。\n\n手机讨论下周的排期。\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n\n## 下周\n\n提交发布说明，附上更新日志。\n\n手机准备演示文稿。\n\n以上是本周重点。\n\n手机补充的说明。\n']
        : ['# 工作清单\n\n本机整理后的设计反馈。\n\n## 下周\n\n提交发布说明。\n\n本机补充的说明。\n',
           '# 工作清单\n\n手机整理后的设计反馈。\n\n## 下周\n\n提交发布说明。\n\n手机补充的说明。\n'];
      content.set('local-0', { text: sides[0], name: '工作清单', archived: false });
      peerContent.set('local-0', { text: sides[1], name: '工作清单', archived: false });
      // 两端必须在看到对方版本之前各自生成版本；先发后收会被自动合并，留下的是冲突之外的结果。
      const local = await engine.offer(); const remote = await peer.offer();
      await engine.receive(remote); await peer.receive(local);
      controller.status = '有同步冲突';
    }
    if (scenario === 'incoming') {
      peerContent.set('new', { text: '新文档', name: '手机上的新项目', archived: false });
      const incomingId = await peer.enable('new', 'project');
      await engine.receive(await peer.offer());
      controller.status = '有待接收文档';
      window.addEventListener('withdraw-preview', () => { void (async () => { await peer.disable(incomingId); await engine.receive(await peer.offer()); })(); }, { once: true });
    }
    if (scenario === 'error') { controller.error = '无法连接电脑，请确认两端连接同一局域网。'; controller.status = '等待同步'; }
    ready = true;
  })(); return () => controller.stop(); });
</script>
{#if ready}<SyncPanel {controller} revision={version} {projects} ensureInspiration={async () => {}} focus={() => ({ destroy() {} })} onClose={() => {}}/>{/if}
