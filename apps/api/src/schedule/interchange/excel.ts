// The programme as an Excel workbook: one row per activity, indented under its summaries, with dates, float and
// predecessors as they are typed in the app, critical activities in red; and the calendars on a second sheet.
import ExcelJS from 'exceljs';
import type { ProgrammeView } from '../programme.service.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function writeProgrammeXlsx(p: ProgrammeView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Aerolith Core';
  const ws = wb.addWorksheet('Programme', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = [
    { width: 12 },
    { width: 50 },
    { width: 8 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 8 },
    { width: 24 },
    { width: 18 },
    { width: 22 },
  ];
  ws.getCell('A1').value = `${p.tender.number} · ${p.tender.title}`;
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A2').value =
    `${p.name}: ${p.startOn} to ${p.finishOn ?? p.startOn}, ${p.duration ?? 0} working days`;
  const head = ws.getRow(4);
  head.values = [
    'ID',
    'Activity',
    'Days',
    'Start',
    'Finish',
    'Late start',
    'Late finish',
    'Float',
    'Predecessors',
    'Calendar',
    'Constraint',
  ];
  head.font = { bold: true };
  const code = new Map(p.activities.map((a) => [a.id, a.code]));
  const cal = new Map(p.calendars.map((c) => [c.id, c.name]));
  const date = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);
  p.activities.forEach((a, i) => {
    const row = ws.getRow(5 + i);
    const preds = p.links
      .filter((l) => l.succ === a.id)
      .map((l) => {
        const lag = l.lag === 0 ? '' : l.lag > 0 ? `+${l.lag}` : String(l.lag);
        return l.type === 'FS' && !l.lag ? code.get(l.pred) : `${code.get(l.pred)}${l.type}${lag}`;
      })
      .join(', ');
    row.values = [
      a.code,
      a.name,
      a.duration,
      date(a.earlyStart),
      date(a.earlyFinish),
      date(a.lateStart),
      date(a.lateFinish),
      a.totalFloat,
      preds,
      a.calendarId ? (cal.get(a.calendarId) ?? '') : '',
      a.constraintType ? `${a.constraintType} ${a.constraintDate}` : '',
    ];
    row.getCell(2).alignment = { indent: a.depth };
    for (const c of [4, 5, 6, 7]) row.getCell(c).numFmt = 'dd-mmm-yy';
    if (a.kind === 'summary') row.font = { bold: true };
    else if (a.critical) row.font = { color: { argb: 'FFB91C1C' } };
  });
  const cs = wb.addWorksheet('Calendars');
  cs.columns = [{ width: 24 }, { width: 30 }, { width: 60 }, { width: 40 }];
  cs.getRow(1).values = ['Calendar', 'Working days', 'Holidays', 'Extra working days'];
  cs.getRow(1).font = { bold: true };
  p.calendars.forEach((c, i) => {
    cs.getRow(2 + i).values = [
      c.id === p.calendarId ? `${c.name} (default)` : c.name,
      WEEKDAYS.filter((_, d) => (c.workWeek & (1 << d)) !== 0).join(', '),
      c.holidays.join(', '),
      c.workingDays.join(', '),
    ];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
