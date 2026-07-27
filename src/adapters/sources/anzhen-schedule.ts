export type AnzhenScheduleDepartment = 'coronary-heart-disease-center' | 'arrhythmia-center';

export type AnzhenScheduleSlot = {
  department: AnzhenScheduleDepartment;
  clinicName: string;
  date: string;
  session: 'AM' | 'PM';
  doctorName: string;
  title: string;
};

export type AnzhenSchedule = {
  range: { start: string; end: string };
  slots: AnzhenScheduleSlot[];
};

export class AnzhenScheduleParseError extends Error {
  readonly code = 'structure_changed';

  constructor(message: string) {
    super(message);
    this.name = 'AnzhenScheduleParseError';
  }
}

const MAX_EXTRACTED_TEXT_LENGTH = 64 * 1024;
const namedEntities: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function assertTextCodePoint(codePoint: number): void {
  const validWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
  const controlCharacter =
    (codePoint >= 0 && codePoint < 0x20 && !validWhitespace) ||
    (codePoint >= 0x7f && codePoint <= 0x9f);
  const surrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  const nonCharacter =
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff;
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    controlCharacter ||
    surrogate ||
    nonCharacter
  ) {
    throw new AnzhenScheduleParseError('HTML entity 包含非法字符');
  }
}

function appendText(parts: string[], value: string, length: number): number {
  const nextLength = length + value.length;
  if (nextLength > MAX_EXTRACTED_TEXT_LENGTH) {
    throw new AnzhenScheduleParseError('HTML 文本长度超出限制');
  }
  parts.push(value);
  return nextLength;
}

function extractTextWithoutTags(html: string): string {
  const parts: string[] = [];
  let length = 0;
  let index = 0;
  while (index < html.length) {
    if (html[index] !== '<') {
      length = appendText(parts, html[index]!, length);
      index += 1;
      continue;
    }

    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      if (commentEnd === -1) {
        throw new AnzhenScheduleParseError('HTML 注释未闭合');
      }
      index = commentEnd + 3;
      continue;
    }

    let quote: '"' | "'" | undefined;
    let closed = false;
    index += 1;
    while (index < html.length) {
      const character = html[index]!;
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        closed = true;
        index += 1;
        break;
      }
      index += 1;
    }
    if (!closed || quote !== undefined) {
      throw new AnzhenScheduleParseError('HTML 标签未闭合');
    }
  }
  return parts.join('');
}

function decodeEntitiesOnce(text: string): string {
  const parts: string[] = [];
  let length = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '&') {
      length = appendText(parts, text[index]!, length);
      index += 1;
      continue;
    }

    const semicolon = text.indexOf(';', index + 1);
    if (semicolon === -1 || semicolon - index > 16) {
      length = appendText(parts, '&', length);
      index += 1;
      continue;
    }
    const entity = text.slice(index + 1, semicolon);
    let decoded = namedEntities[entity.toLowerCase()];
    const decimal = entity.match(/^#([0-9]+)$/);
    const hexadecimal = entity.match(/^#x([0-9a-f]+)$/i);
    if (decimal || hexadecimal) {
      const codePoint = Number.parseInt((decimal ?? hexadecimal)![1]!, decimal ? 10 : 16);
      assertTextCodePoint(codePoint);
      decoded = String.fromCodePoint(codePoint);
    }
    if (decoded === undefined) {
      length = appendText(parts, '&', length);
      index += 1;
      continue;
    }
    length = appendText(parts, decoded, length);
    index = semicolon + 1;
  }
  return parts.join('');
}

const decodeText = (html: string): string =>
  decodeEntitiesOnce(extractTextWithoutTags(html)).replace(/\s+/g, ' ').trim();

const classNames = (attributes: string): string[] => {
  const match = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  return match?.[2]?.split(/\s+/).filter(Boolean) ?? [];
};

const hasClass = (attributes: string, name: string): boolean =>
  classNames(attributes).includes(name);

const extractCells = (rowHtml: string, tag = 'td') =>
  Array.from(
    rowHtml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi')),
    (match) => ({ attributes: match[1] ?? '', content: match[2] ?? '' }),
  );

const titleByLevel: Readonly<Record<string, string>> = {
  '1': '普通门诊',
  '2': '专家门诊',
  '3': '特需门诊',
  '4': '专科门诊',
  '5': '知名专家团队',
  '6': '主任医师',
  '7': '副主任医师',
  '8': '主治医师',
  '9': '医师',
  '10': '知名专家医师',
  '11': '研究员',
  '18': '特需知名专家',
  '19': '免费号',
  '20': '特需特级知名专家',
  '21': '特需副主任医师',
  '22': '特需主任医师',
  '23': '特需知名专家复诊',
  '24': '特需主任医师复诊',
  '25': '特需双科联合诊疗',
  '26': '特需三科联合诊疗',
  '27': '副中心门诊部',
  '28': '母胎医学联合诊疗',
  '29': '特需四科联合诊疗',
  '30': '知名专家',
  '31': '药学门诊',
};

function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function departmentFromText(value: string): AnzhenScheduleDepartment | undefined {
  if (/^冠心病中心.+门诊\(朝阳\)$/.test(value)) return 'coronary-heart-disease-center';
  if (/^心律失常中心.+门诊\(朝阳\)$/.test(value)) return 'arrhythmia-center';
  return undefined;
}

function doctorsFromCell(cellHtml: string): Array<{ doctorName: string; title: string }> {
  const doctors = Array.from(
    cellHtml.matchAll(
      /<a\b[^>]*href\s*=\s*(["'])\/Html\/(?:Doctors\/Main\/Index_|Hospitals\/Doctors\/Index)\d+\.html\1[^>]*>([\s\S]*?)<\/a>\s*<span\b[^>]*class\s*=\s*(["'])[^"']*\bSchedulingLevel_icon(\d+)\b[^"']*\3[^>]*>/gi,
    ),
    (match) => {
      const doctorName = decodeText(match[2] ?? '');
      const title = titleByLevel[match[4] ?? ''];
      if (!/^[\p{Script=Han}·]{2,12}$/u.test(doctorName) || !title) {
        throw new AnzhenScheduleParseError('医生姓名或职称图例无法识别');
      }
      return { doctorName, title };
    },
  );

  const cards = cellHtml.match(/class\s*=\s*(["'])[^"']*\bshowson\b[^"']*\1/gi)?.length ?? 0;
  if (cards !== doctors.length) {
    throw new AnzhenScheduleParseError('排班单元格医生卡片结构已变化');
  }
  return doctors;
}

export function parseAnzhenHeartCenterSchedule(html: string): AnzhenSchedule {
  if (!/<title>[\s\S]*心脏内科医学中心[\s\S]*北京安贞医院[\s\S]*<\/title>/i.test(html)) {
    throw new AnzhenScheduleParseError('页面不是北京安贞医院心脏内科医学中心');
  }

  const startMatch = html.match(
    /<input\b[^>]*id\s*=\s*(["'])schdate_0\1[^>]*value\s*=\s*(["'])(\d{4})\/(\d{1,2})\/(\d{1,2})\s+0:00:00\2[^>]*>/i,
  );
  if (!startMatch) throw new AnzhenScheduleParseError('未找到排班起始日期');
  const start = isoDate(Number(startMatch[3]), Number(startMatch[4]), Number(startMatch[5]));
  const dates = Array.from({ length: 7 }, (_value, index) => addDays(start, index));

  const tableMatch = html.match(
    /<table\b([^>]*)class\s*=\s*(["'])[^"']*\bclinicDetail\b[^"']*\2[^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!tableMatch) throw new AnzhenScheduleParseError('未找到官方周排班表');
  const tableHtml = tableMatch[3] ?? '';
  const header = tableHtml.match(/<tr\b[^>]*class\s*=\s*(["'])[^"']*\bfrist_tr\b[^"']*\1[^>]*>([\s\S]*?)<\/tr>/i);
  const headerText = header ? decodeText(header[2] ?? '') : '';
  if (!['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'].every((day) => headerText.includes(day))) {
    throw new AnzhenScheduleParseError('周排班日期表头不完整');
  }

  const seenDepartments = new Set<AnzhenScheduleDepartment>();
  const slots: AnzhenScheduleSlot[] = [];
  let currentDepartment:
    | { department: AnzhenScheduleDepartment; clinicName: string }
    | undefined;

  for (const row of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = extractCells(row[1] ?? '');
    if (cells.length === 0) continue;

    let sessionCellIndex = 0;
    if (hasClass(cells[0]!.attributes, 'Dep_Name')) {
      const clinicName = decodeText(cells[0]!.content);
      const department = departmentFromText(clinicName);
      currentDepartment = department ? { department, clinicName } : undefined;
      sessionCellIndex = 1;
    }
    if (!currentDepartment) continue;

    const sessionCell = cells[sessionCellIndex];
    if (!sessionCell || !hasClass(sessionCell.attributes, 'daytime')) {
      throw new AnzhenScheduleParseError('目标科室排班缺少时段列');
    }
    const sessionText = decodeText(sessionCell.content);
    const session = sessionText === '上午' ? 'AM' : sessionText === '下午' ? 'PM' : undefined;
    if (!session) throw new AnzhenScheduleParseError('目标科室排班出现未知时段');

    const dateCells = cells.slice(sessionCellIndex + 1);
    if (dateCells.length !== dates.length) {
      throw new AnzhenScheduleParseError('目标科室排班日期列数量已变化');
    }
    seenDepartments.add(currentDepartment.department);
    for (const [index, cell] of dateCells.entries()) {
      for (const doctor of doctorsFromCell(cell.content)) {
        slots.push({
          department: currentDepartment.department,
          clinicName: currentDepartment.clinicName,
          date: dates[index]!,
          session,
          ...doctor,
        });
      }
    }
  }

  if (
    !seenDepartments.has('coronary-heart-disease-center') ||
    !seenDepartments.has('arrhythmia-center') ||
    slots.length === 0
  ) {
    throw new AnzhenScheduleParseError('目标科室排班上下文不完整');
  }

  return { range: { start, end: dates.at(-1)! }, slots };
}
