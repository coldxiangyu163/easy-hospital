export type PumchSchedulePeriod = 'morning' | 'afternoon';

export interface PumchScheduleSession {
  date: string;
  period: PumchSchedulePeriod;
  doctors: string[];
}

export interface PumchSchedule {
  range: {
    start: string;
    end: string;
  };
  sessions: PumchScheduleSession[];
}

export class PumchScheduleParseError extends Error {
  readonly code = 'structure_changed';

  constructor(message: string) {
    super(message);
    this.name = 'PumchScheduleParseError';
  }
}

const decodeText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

const hasClass = (attributes: string, className: string): boolean => {
  const classMatch = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  return classMatch?.[2]?.split(/\s+/).includes(className) ?? false;
};

const extractCells = (
  rowHtml: string,
): Array<{ attributes: string; content: string }> =>
  Array.from(rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi), (match) => ({
    attributes: match[1] ?? '',
    content: match[2] ?? '',
  }));

const ACTION_TEXT_PATTERN =
  /(?:预约|挂号|详情|查看|介绍|专家|出诊|停诊|约满|无号|有号|候补|可用|点击|前往|立即|咨询|服务)/;

const parseDoctorNames = (cellHtml: string): string[] => {
  const doctors: string[] = [];
  for (const match of cellHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const doctorName = decodeText(match[2] ?? '');
    if (!doctorName || ACTION_TEXT_PATTERN.test(doctorName)) continue;

    const recognizedName = /^[\p{Script=Han}·]{2,12}$/u.test(doctorName);
    if (!recognizedName) {
      throw new PumchScheduleParseError('排班单元格出现非医生文字');
    }
    doctors.push(doctorName);
  }

  return [...new Set(doctors)];
};

export function parsePumchSchedule(html: string): PumchSchedule {
  const dates = Array.from(html.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi))
    .filter((match) => hasClass(match[1] ?? '', 'th3'))
    .map((match) => decodeText(match[2] ?? '').match(/\b(\d{4})\.(\d{2})\.(\d{2})\b/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => `${match[1]}-${match[2]}-${match[3]}`);

  if (dates.length === 0) {
    throw new PumchScheduleParseError('未找到协和公开排班日期表头');
  }

  const sessions: PumchScheduleSession[] = [];
  let periodRows = 0;
  let matchedScheduleRows = 0;

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = extractCells(rowMatch[1] ?? '');
    const periodCell = cells.find((cell) => {
      const text = decodeText(cell.content);
      return text === '上午' || text === '下午';
    });
    const periodText = periodCell ? decodeText(periodCell.content) : '';
    const period =
      periodText === '上午'
        ? 'morning'
        : periodText === '下午'
          ? 'afternoon'
          : undefined;

    if (!period) continue;
    periodRows += 1;

    let matchedDateCells = 0;
    for (const [index, date] of dates.entries()) {
      const dateCell = cells.find((cell) => hasClass(cell.attributes, `tdh${index + 3}`));
      if (!dateCell) continue;
      matchedDateCells += 1;

      const doctors = parseDoctorNames(dateCell.content);
      if (doctors.length > 0) {
        sessions.push({
          date,
          period,
          doctors,
        });
      }
    }

    if (matchedDateCells > 0) matchedScheduleRows += 1;
  }

  if (periodRows === 0 || matchedScheduleRows === 0) {
    throw new PumchScheduleParseError('未找到协和公开排班上午或下午行');
  }

  return {
    range: {
      start: dates[0]!,
      end: dates.at(-1)!,
    },
    sessions,
  };
}
