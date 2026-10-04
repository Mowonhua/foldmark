/**
 * 文件职责：为侧栏大纲目录提供区域过滤、投影可见性与滚动定位的纯函数。
 * 定义范围：待办/归档分区的标题集合、可见性判定与视口顶部章节映射。
 */
import type { DocumentModel, HiddenRange } from './types';
import { archiveSections } from './archive';

/** 结构职责：表示大纲目录中的一个标题条目。 */
export interface OutlineEntry {
  /** 原文坐标中标题起点，点击定位与条目身份使用。 */
  from: number;
  level: number;
  text: string;
  /** 当前投影中该标题是否可见；不可见条目置灰且不可点击。 */
  visible: boolean;
}

/**
 * 函数职责：按当前标签页切分大纲条目，并依据投影隐藏范围标注可见性。
 * 输入说明：tab 决定区域归属——归档章节内（含归档标题本身）属于归档页，其余属于待办页，
 * 区域边界复用 archiveSections，与正文投影共用同一套判定；hidden 为当前模式的隐藏范围。
 * 输出说明：按原文顺序返回条目；hidden 未覆盖的标题可见。
 * 实现思路：位置包含判断即可对齐行级隐藏范围，因为标题起点与隐藏范围都按整行对齐。
 */
export function outlineEntries(model: DocumentModel, tab: 'todo' | 'archive', hidden: HiddenRange[] = []): OutlineEntry[] {
  const sections = archiveSections(model);
  const inArchive = (from: number): boolean => sections.some(section => from >= section.from && from < section.to);
  const isHidden = (from: number): boolean => hidden.some(range => from >= range.from && from < range.to);
  return model.headings
    .filter(heading => tab === 'archive' ? inArchive(heading.from) : !inArchive(heading.from))
    .map(heading => ({ from: heading.from, level: heading.level, text: heading.text, visible: !isHidden(heading.from) }));
}

/** 结构职责：表示一个标题在滚动坐标系中的顶部位置，单位与 scrollDOM.scrollTop 一致。 */
export interface OutlinePosition { from: number; top: number }

/**
 * 函数职责：把视口顶部像素位置映射为当前章节标题。
 * 输入说明：positions 覆盖全部标题且按 top 升序；listed 为当前列表中可见条目的 from 集合；
 * maxScroll 是滚动容器可达到的最大 scrollTop，缺省无穷表示不启用到底判定。
 * 输出说明：返回视口顶部以上最后一个、且属于当前列表的标题；候选不存在或不在列表中返回 null。
 * 实现思路：视口顶部上方没有标题时视为停留在首个章节；滚动到底时正文末段完整可见，
 * 列表中最后一个标题即当前章节；候选落在当前分区外时不产生高亮。
 */
export function activeOutlineFrom(positions: readonly OutlinePosition[], scrollTop: number, listed: ReadonlySet<number>, maxScroll = Number.POSITIVE_INFINITY): number | null {
  if (positions.length && maxScroll - scrollTop <= 1) {
    for (let index = positions.length - 1; index >= 0; index--) {
      if (listed.has(positions[index].from)) return positions[index].from;
    }
    return null;
  }
  let candidate: number | null = null;
  for (const item of positions) {
    if (item.top > scrollTop + 1) break;
    candidate = item.from;
  }
  if (candidate === null) candidate = positions[0]?.from ?? null;
  return candidate !== null && listed.has(candidate) ? candidate : null;
}
