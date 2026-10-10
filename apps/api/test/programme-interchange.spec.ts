// Reading and writing other tools' programme files (src/schedule/interchange): an MS Project XML file written the way
// MS Project 2016 saves one, and a Primavera XER file the way P6 exports one, with the awkward parts (a derived
// calendar, a holiday range, a link on a summary, a duration that is not whole days, progress, a level-of-effort
// activity); then our own exports read back unchanged, and the Excel export.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readMspdi, writeMspdi, durationHours } from '../src/schedule/interchange/mspdi.js';
import { toOps } from '../src/schedule/interchange/imported.js';
import { parseClndrData, readXer, writeXer } from '../src/schedule/interchange/xer.js';
import { writeProgrammeXlsx } from '../src/schedule/interchange/excel.js';
import type { ProgrammeView } from '../src/schedule/programme.service.js';

const MSP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <SaveVersion>14</SaveVersion>
  <Name>Hostel.xml</Name>
  <Title>Hostel block</Title>
  <StartDate>2026-11-02T08:00:00</StartDate>
  <FinishDate>2026-11-20T17:00:00</FinishDate>
  <CalendarUID>1</CalendarUID>
  <MinutesPerDay>480</MinutesPerDay>
  <Calendars>
    <Calendar>
      <UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
      <WeekDays>
        <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
      </WeekDays>
      <Exceptions>
        <Exception>
          <TimePeriod><FromDate>2026-11-09T00:00:00</FromDate><ToDate>2026-11-10T23:59:00</ToDate></TimePeriod>
          <Name>Diwali</Name><DayWorking>0</DayWorking>
        </Exception>
      </Exceptions>
    </Calendar>
    <Calendar>
      <UID>3</UID><Name>Site six-day</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID>
      <WeekDays>
        <WeekDay><DayType>7</DayType><DayWorking>1</DayWorking></WeekDay>
      </WeekDays>
    </Calendar>
    <Calendar>
      <UID>9</UID><Name>Unused resource calendar</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID>
    </Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>Hostel block</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task>
      <UID>1</UID><ID>1</ID><Name>Civil works</Name><OutlineLevel>1</OutlineLevel><Duration>PT120H0M0S</Duration>
      <Summary>1</Summary><ConstraintType>0</ConstraintType><CalendarUID>-1</CalendarUID>
    </Task>
    <Task>
      <UID>2</UID><ID>2</ID><Name>Excavation</Name><OutlineLevel>2</OutlineLevel><Duration>PT40H0M0S</Duration>
      <Milestone>0</Milestone><Summary>0</Summary><ConstraintType>4</ConstraintType><CalendarUID>3</CalendarUID>
      <ConstraintDate>2026-11-03T08:00:00</ConstraintDate>
    </Task>
    <Task>
      <UID>3</UID><ID>3</ID><Name>Footings</Name><OutlineLevel>2</OutlineLevel><Duration>PT36H0M0S</Duration>
      <ConstraintType>0</ConstraintType><CalendarUID>-1</CalendarUID>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
    <Task><UID>6</UID><ID>4</ID><IsNull>1</IsNull></Task>
    <Task>
      <UID>4</UID><ID>5</ID><Name>Plinth complete</Name><OutlineLevel>1</OutlineLevel><Duration>PT0H0M0S</Duration>
      <Milestone>1</Milestone><ConstraintType>1</ConstraintType>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type><LinkLag>-4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>0</Type><LinkLag>50</LinkLag><LagFormat>19</LagFormat></PredecessorLink>
    </Task>
  </Tasks>
</Project>`;

describe('MS Project XML', () => {
  it('reads tasks, outline levels, durations, links, lags and constraints', () => {
    const p = readMspdi(MSP);
    expect(p).toMatchObject({
      format: 'mspdi',
      name: 'Hostel block',
      startOn: '2026-11-02',
      fileFinish: '2026-11-20',
    });
    expect(p.activities.map((a) => [a.key, a.parentKey, a.code, a.duration, a.summary])).toEqual([
      ['1', null, '1', 15, true],
      ['2', '1', '2', 5, false],
      ['3', '1', '3', 5, false], // 4.5 days rounded
      ['4', null, '5', 0, false],
    ]);
    expect(p.activities[1]).toMatchObject({
      calendarKey: '3',
      constraint: { type: 'SNET', date: '2026-11-03' },
    });
    expect(p.links).toEqual([
      { pred: '2', succ: '3', type: 'FS', lag: 1 },
      { pred: '3', succ: '4', type: 'SS', lag: -1 },
      { pred: '1', succ: '4', type: 'FS', lag: 0 },
      { pred: '2', succ: '4', type: 'FF', lag: 0 },
    ]);
    expect(p.warnings).toEqual([
      '3 Footings: 4.50 days rounded to 5.',
      'A link into 5 has a lag in percent; it was set to no lag.',
      '1 activities were "as late as possible"; here they are scheduled as early as possible.',
    ]);
  });

  it('reads calendars: weekdays, holiday ranges, and a derived calendar over its base', () => {
    const p = readMspdi(MSP);
    expect(p.defaultCalendarKey).toBe('1');
    expect(p.calendars).toEqual([
      {
        key: '1',
        name: 'Standard',
        workWeek: 0b0011111,
        holidays: ['2026-11-09', '2026-11-10'],
        workingDays: [],
      },
      {
        key: '3',
        name: 'Site six-day',
        workWeek: 0b0111111,
        holidays: ['2026-11-09', '2026-11-10'],
        workingDays: [],
      },
    ]);
  });

  it('drops links on summary rows when building the programme, and says so', () => {
    const p = readMspdi(MSP);
    const { ops, warnings } = toOps(
      p,
      new Map([
        ['1', 'cal-1'],
        ['3', 'cal-3'],
      ]),
    );
    expect(ops.filter((o) => o.op === 'link')).toHaveLength(3);
    expect(warnings).toEqual([
      'Link 1 → 5 is on a summary row; summaries take no links here, so it was left out.',
    ]);
    expect(ops[1]).toMatchObject({
      op: 'insert',
      tempId: 't1',
      parentId: 't0',
      calendarId: 'cal-3',
    });
  });

  it('reads ISO durations', () => {
    expect(durationHours('PT40H0M0S')).toBe(40);
    expect(durationHours('PT7H30M0S')).toBe(7.5);
    expect(durationHours('P2D')).toBe(48);
    expect(durationHours('soon')).toBeNull();
  });

  it('refuses a file that is not MS Project XML', () => {
    expect(() => readMspdi('<html></html>')).toThrow(/not an MS Project file/);
    expect(() => readMspdi('<Project><unclosed></Project>')).toThrow(/not a readable XML file/);
  });
});

// clndr_data as P6 writes it: nested, indented, with 0x7f padding.
const CLNDR =
  '(0||CalendarData()(\x7f\x7f  (0||DaysOfWeek()(\x7f\x7f    (0||1()())\x7f\x7f' +
  [2, 3, 4, 5, 6, 7]
    .map(
      (d) =>
        `    (0||${d}()(\x7f\x7f      (0||0(s|08:00|f|12:00)())\x7f\x7f      (0||1(s|13:00|f|17:00)())))`,
    )
    .join('\x7f\x7f') +
  ')\x7f\x7f  (0||VIEW(ShowTotal|Y)())\x7f\x7f  (0||Exceptions()(\x7f\x7f' +
  '    (0||0(d|46335)())\x7f\x7f' + // 9 Nov 2026: holiday
  '    (0||1(d|46341)(\x7f\x7f      (0||0(s|08:00|f|17:00)())))))))';

const tab = (cells: (string | number)[]) => cells.join('\t');
const XER = [
  tab([
    'ERMHDR',
    '19.12',
    '2026-10-01',
    'Project',
    'admin',
    'Admin',
    'dbxDatabaseNoName',
    'Project Management',
    'INR',
  ]),
  '%T\tCALENDAR',
  tab(['%F', 'clndr_id', 'clndr_name', 'day_hr_cnt', 'clndr_data']),
  tab(['%R', '77', 'Site Mon-Sat', '8', CLNDR]),
  tab(['%R', '78', 'Unused', '8', '(0||CalendarData()())']),
  '%T\tPROJECT',
  tab([
    '%F',
    'proj_id',
    'proj_short_name',
    'clndr_id',
    'plan_start_date',
    'last_recalc_date',
    'scd_end_date',
  ]),
  tab(['%R', '500', 'HOSTEL', '77', '2026-11-02 08:00', '2026-11-02 08:00', '2026-11-25 17:00']),
  '%T\tPROJWBS',
  tab([
    '%F',
    'wbs_id',
    'proj_id',
    'seq_num',
    'proj_node_flag',
    'wbs_short_name',
    'wbs_name',
    'parent_wbs_id',
  ]),
  tab(['%R', '900', '500', '0', 'Y', 'HOSTEL', 'Hostel', '']),
  tab(['%R', '901', '500', '1', 'N', 'CIV', 'Civil works', '900']),
  tab(['%R', '902', '500', '1', 'N', 'FND', 'Foundations', '901']),
  '%T\tTASK',
  tab([
    '%F',
    'task_id',
    'proj_id',
    'wbs_id',
    'clndr_id',
    'task_code',
    'task_name',
    'task_type',
    'status_code',
    'target_drtn_hr_cnt',
    'cstr_type',
    'cstr_date',
    'act_start_date',
    'early_end_date',
  ]),
  tab([
    '%R',
    '1',
    '500',
    '902',
    '77',
    'A1000',
    'Excavation',
    'TT_Task',
    'TK_Active',
    '40',
    'CS_MSOA',
    '2026-11-03 08:00',
    '2026-11-02 08:00',
    '2026-11-06 17:00',
  ]),
  tab([
    '%R',
    '2',
    '500',
    '902',
    '77',
    'A1010',
    'Footings',
    'TT_Task',
    'TK_NotStart',
    '32',
    '',
    '',
    '',
    '2026-11-12 17:00',
  ]),
  tab([
    '%R',
    '3',
    '500',
    '901',
    '77',
    'A1020',
    'Supervision',
    'TT_LOE',
    'TK_NotStart',
    '16',
    '',
    '',
    '',
    '',
  ]),
  tab([
    '%R',
    '4',
    '500',
    '900',
    '77',
    'M100',
    'Plinth complete',
    'TT_FinMile',
    'TK_NotStart',
    '0',
    '',
    '',
    '',
    '2026-11-12 17:00',
  ]),
  '%T\tTASKPRED',
  tab(['%F', 'task_pred_id', 'task_id', 'pred_task_id', 'pred_type', 'lag_hr_cnt']),
  tab(['%R', '1', '2', '1', 'PR_FS', '8']),
  tab(['%R', '2', '4', '2', 'PR_SS', '-16']),
  tab(['%R', '3', '4', '999', 'PR_FS', '0']),
  '%E',
].join('\r\n');

describe('Primavera XER', () => {
  it("reads P6's calendar text: working weekdays, a holiday and a worked Sunday", () => {
    const tree = parseClndrData(CLNDR);
    expect(tree[0]!.name).toBe('CalendarData');
    const p = readXer(XER);
    expect(p.calendars).toEqual([
      {
        key: '77',
        name: 'Site Mon-Sat',
        workWeek: 0b0111111,
        holidays: ['2026-11-09'],
        workingDays: ['2026-11-15'],
      },
    ]);
  });

  it('reads the WBS as summaries, activities with their durations, and relationships', () => {
    const p = readXer(XER);
    expect(p).toMatchObject({
      format: 'xer',
      name: 'HOSTEL',
      startOn: '2026-11-02',
      fileFinish: '2026-11-25',
    });
    expect(p.activities.map((a) => [a.code, a.parentKey, a.duration, a.summary])).toEqual([
      ['M100', null, 0, false],
      ['CIV', null, 0, true],
      ['A1020', 'wbs:901', 2, false],
      ['CIV.FND', 'wbs:901', 0, true],
      ['A1000', 'wbs:902', 5, false],
      ['A1010', 'wbs:902', 4, false],
    ]);
    expect(p.activities.find((a) => a.code === 'A1000')!.constraint).toEqual({
      type: 'SNET',
      date: '2026-11-03',
    });
    expect(p.links).toEqual([
      { pred: 'task:1', succ: 'task:2', type: 'FS', lag: 1 },
      { pred: 'task:2', succ: 'task:4', type: 'SS', lag: -2 },
    ]);
    expect(p.warnings).toEqual([
      'A1020 is a level-of-effort activity in P6; here it is an ordinary task.',
      '1 activities have progress in P6; progress is not imported, so their original durations were used.',
    ]);
  });

  it('refuses a file that is not an XER', () => {
    expect(() => readXer('Code,Name\n')).toThrow(/not a Primavera XER file/);
  });
});

// A programme as the API holds it, for the writers.
const view = {
  id: 'p1',
  tenderId: 't1',
  tender: { number: 'TND/2026-27/0004', title: 'Hostel block, Yavatmal' },
  owner: { kind: 'tender', id: 't1', number: 'TND/2026-27/0004', title: 'Hostel block, Yavatmal' },
  name: 'Submission programme',
  startOn: '2026-11-02',
  calendarId: 'c1',
  notes: '',
  finishOn: '2026-11-12',
  duration: 9,
  activityCount: 4,
  computedAt: null,
  archivedAt: null,
  rowVersion: 3,
  calendars: [
    {
      id: 'c1',
      name: 'Site (Mon–Sat)',
      workWeek: 0b0111111,
      holidays: ['2026-11-09'],
      workingDays: ['2026-11-15'],
    },
    { id: 'c2', name: 'Office (Mon–Fri)', workWeek: 0b0011111, holidays: [], workingDays: [] },
  ],
  activities: [
    {
      id: '1',
      parentId: null,
      depth: 0,
      kind: 'summary',
      code: 'A1030',
      name: 'Civil works',
      duration: 9,
      calendarId: null,
      constraintType: null,
      constraintDate: null,
      notes: '',
      earlyStart: '2026-11-02',
      earlyFinish: '2026-11-12',
      lateStart: '2026-11-02',
      lateFinish: '2026-11-12',
      totalFloat: 0,
      freeFloat: 0,
      critical: true,
    },
    {
      id: '2',
      parentId: '1',
      depth: 1,
      kind: 'task',
      code: 'A1000',
      name: 'Excavation & shoring',
      duration: 5,
      calendarId: 'c2',
      constraintType: 'SNET',
      constraintDate: '2026-11-03',
      notes: 'Hard strata',
      earlyStart: '2026-11-03',
      earlyFinish: '2026-11-09',
      lateStart: '2026-11-03',
      lateFinish: '2026-11-09',
      totalFloat: 0,
      freeFloat: 0,
      critical: true,
    },
    {
      id: '3',
      parentId: '1',
      depth: 1,
      kind: 'task',
      code: 'A1010',
      name: 'Footings',
      duration: 4,
      calendarId: null,
      constraintType: null,
      constraintDate: null,
      notes: '',
      earlyStart: '2026-11-10',
      earlyFinish: '2026-11-12',
      lateStart: '2026-11-10',
      lateFinish: '2026-11-12',
      totalFloat: 0,
      freeFloat: 0,
      critical: true,
    },
    {
      id: '4',
      parentId: null,
      depth: 0,
      kind: 'milestone',
      code: 'M100',
      name: 'Plinth complete',
      duration: 0,
      calendarId: null,
      constraintType: null,
      constraintDate: null,
      notes: '',
      earlyStart: '2026-11-12',
      earlyFinish: '2026-11-12',
      lateStart: '2026-11-12',
      lateFinish: '2026-11-12',
      totalFloat: 0,
      freeFloat: 0,
      critical: true,
    },
  ],
  links: [
    { pred: '2', succ: '3', type: 'FS', lag: 1 },
    { pred: '3', succ: '4', type: 'FF', lag: -2 },
  ],
} as unknown as ProgrammeView;

/** What survives a round trip: rows by code under their parents, durations, calendars by name, links by code. */
function shape(p: ReturnType<typeof readMspdi>) {
  const codeOf = new Map(p.activities.map((a) => [a.key, a.code]));
  const calName = new Map(p.calendars.map((c) => [c.key, c.name]));
  return {
    rows: p.activities.map((a) => [
      a.code,
      a.parentKey ? codeOf.get(a.parentKey) : null,
      a.summary ? 'summary' : a.duration,
      a.calendarKey ? calName.get(a.calendarKey) : null,
      a.constraint,
    ]),
    links: p.links.map((l) => [codeOf.get(l.pred), codeOf.get(l.succ), l.type, l.lag]),
    calendars: p.calendars.map(({ key: _k, ...c }) => c),
    default: calName.get(p.defaultCalendarKey ?? ''),
  };
}

describe('our own exports, read back', () => {
  it('MS Project XML keeps IDs, outline, durations, calendars, links and constraints', () => {
    const back = readMspdi(writeMspdi(view));
    expect(back.warnings).toEqual([]);
    expect(back).toMatchObject({
      name: 'Submission programme',
      startOn: '2026-11-02',
      fileFinish: '2026-11-12',
    });
    expect(shape(back)).toEqual({
      rows: [
        ['A1030', null, 'summary', null, null],
        ['A1000', 'A1030', 5, 'Office (Mon–Fri)', { type: 'SNET', date: '2026-11-03' }],
        ['A1010', 'A1030', 4, null, null],
        ['M100', null, 0, null, null],
      ],
      links: [
        ['A1000', 'A1010', 'FS', 1],
        ['A1010', 'M100', 'FF', -2],
      ],
      calendars: [
        {
          name: 'Site (Mon–Sat)',
          workWeek: 0b0111111,
          holidays: ['2026-11-09'],
          workingDays: ['2026-11-15'],
        },
        { name: 'Office (Mon–Fri)', workWeek: 0b0011111, holidays: [], workingDays: [] },
      ],
      default: 'Site (Mon–Sat)',
    });
  });

  it('XER keeps the same, with summaries as WBS nodes', () => {
    const back = readXer(writeXer(view, new Date('2026-10-09T10:00:00Z')));
    expect(back.warnings).toEqual([]);
    const s = shape(back as ReturnType<typeof readMspdi>);
    expect(s.rows).toEqual([
      ['M100', null, 0, null, null],
      ['A1030', null, 'summary', null, null],
      ['A1000', 'A1030', 5, 'Office (Mon–Fri)', { type: 'SNET', date: '2026-11-03' }],
      ['A1010', 'A1030', 4, null, null],
    ]);
    expect(s.links).toEqual([
      ['A1000', 'A1010', 'FS', 1],
      ['A1010', 'M100', 'FF', -2],
    ]);
    expect(s.calendars).toEqual([
      {
        name: 'Site (Mon–Sat)',
        workWeek: 0b0111111,
        holidays: ['2026-11-09'],
        workingDays: ['2026-11-15'],
      },
      { name: 'Office (Mon–Fri)', workWeek: 0b0011111, holidays: [], workingDays: [] },
    ]);
    expect(s.default).toBe('Site (Mon–Sat)');
  });

  it('Excel lists every row with dates, float and predecessors as typed', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await writeProgrammeXlsx(view)) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Programme')!;
    expect(ws.getCell('A1').value).toBe('TND/2026-27/0004 · Hostel block, Yavatmal');
    expect((ws.getRow(6).values as unknown[]).slice(1, 3)).toEqual([
      'A1000',
      'Excavation & shoring',
    ]);
    expect(ws.getCell('I7').value).toBe('A1000FS+1');
    expect(ws.getCell('I8').value).toBe('A1010FF-2');
    expect(ws.getCell('J6').value).toBe('Office (Mon–Fri)');
    expect(wb.getWorksheet('Calendars')!.getCell('A2').value).toBe('Site (Mon–Sat) (default)');
  });
});
