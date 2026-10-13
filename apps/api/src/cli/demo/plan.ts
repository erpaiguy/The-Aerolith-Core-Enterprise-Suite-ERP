// The demo company's story, as data (history.ts replays it through the API). Deshmukh Infra Pvt Ltd, Washim: a
// building contractor incorporated in January 2024 with ₹1 crore of capital, ten staff and a labour force engaged
// through three labour contractors, doing about ₹2.4 crore of work a year. Figures are illustrative, not advice.
import type { Day } from './util.js';

export const COMPANY = {
  name: 'Deshmukh Infra Pvt Ltd',
  legalName: 'Deshmukh Infra Private Limited',
  gstin: '27AAACD1234K1Z5',
  pan: 'AAACD1234K',
  tan: 'NGPD01234E',
  stateCode: '27',
  address: 'Plot 14, MIDC Area, Akola Road',
  city: 'Washim',
  pincode: '444505',
  booksFrom: '2024-01-01',
  incorporatedOn: '2024-01-02',
  capital: 10_000_000,
  capitalOn: '2024-01-05',
};

// --- parties ---
export interface PartyPlan {
  key: string;
  name: string;
  kind: 'client' | 'vendor' | 'subcontractor' | 'competitor';
  gstin?: string;
  pan?: string;
  email?: string;
  phone?: string;
  city?: string;
  tdsSection?: '194C' | '194J' | '194I' | '194Q';
  bank?: { name: string; no: string; ifsc: string };
}
export const PARTIES: PartyPlan[] = [
  // clients
  { key: 'zp', name: 'Zilla Parishad Washim', kind: 'client', gstin: '27AAALZ0123P1ZK', email: 'ee.works@zpwashim.demo', city: 'Washim' },
  { key: 'gpRisod', name: 'Gram Panchayat Risod', kind: 'client', email: 'gp.risod@maha.demo', city: 'Risod' },
  { key: 'pwd', name: 'Public Works Division Washim', kind: 'client', gstin: '27AAAGP4567H1ZQ', email: 'ee.pwd@washim.demo', city: 'Washim' },
  { key: 'apmc', name: 'APMC Mangrulpir', kind: 'client', gstin: '27AAALA2345M1ZD', email: 'secretary@apmcmangrulpir.demo', city: 'Mangrulpir' },
  { key: 'sss', name: 'Shivaji Shikshan Sanstha', kind: 'client', gstin: '27AAATS3456C1ZE', email: 'office@sss.demo', city: 'Amravati' },
  { key: 'amc', name: 'Akola Municipal Corporation', kind: 'client', gstin: '27AAALA9876K1ZF', email: 'works@akolamc.demo', city: 'Akola' },
  { key: 'police', name: 'Maharashtra Police Housing Corporation', kind: 'client', gstin: '27AAACM5678P1ZG', email: 'ee.washim@mphc.demo', city: 'Washim' },
  { key: 'health', name: 'Public Health Department, Buldhana', kind: 'client', gstin: '27AAAGP7890B1ZH', email: 'cs.buldhana@health.demo', city: 'Buldhana' },
  // suppliers
  { key: 'cement', name: 'Vidarbha Cement Traders', kind: 'vendor', gstin: '27AAACV1234F1Z5', email: 'orders@vct.demo', city: 'Akola', bank: { name: 'Vidarbha Cement Traders', no: '50200011223344', ifsc: 'HDFC0001234' } },
  { key: 'steel', name: 'Shinde Steel Traders', kind: 'vendor', gstin: '27ABCPS4321L1Z9', email: 'sales@shinde-steel.demo', city: 'Akola', bank: { name: 'Shinde Steel Traders', no: '30110022334455', ifsc: 'SBIN0001122' } },
  { key: 'sand', name: 'Godavari Sand and Aggregates', kind: 'vendor', gstin: '27AAGFG5678K1Z2', email: 'godavari.agg@demo.in', city: 'Washim', bank: { name: 'Godavari Sand and Aggregates', no: '60220033445566', ifsc: 'MAHB0000456' } },
  { key: 'bricks', name: 'Washim Bricks Company', kind: 'vendor', gstin: '27AACFW2345M1Z3', email: 'washimbricks@demo.in', city: 'Washim', bank: { name: 'Washim Bricks Company', no: '70330044556677', ifsc: 'BKID0007890' } },
  { key: 'tiles', name: 'Om Tiles and Sanitary', kind: 'vendor', gstin: '27AAFPO3456N1Z4', email: 'omtiles@demo.in', city: 'Akola', bank: { name: 'Om Tiles and Sanitary', no: '80440055667788', ifsc: 'HDFC0004567' } },
  { key: 'paints', name: 'Rang Paints Washim', kind: 'vendor', gstin: '27ABQPR6789P1Z6', email: 'rangpaints@demo.in', city: 'Washim', bank: { name: 'Rang Paints', no: '90550066778899', ifsc: 'ICIC0001357' } },
  { key: 'hardware', name: 'Akola Hardware Stores', kind: 'vendor', gstin: '27AAKFA8901R1Z8', email: 'akolahardware@demo.in', city: 'Akola', bank: { name: 'Akola Hardware Stores', no: '11660077889900', ifsc: 'UBIN0532145' } },
  { key: 'fuel', name: 'Jai Hind Fuels', kind: 'vendor', gstin: '27AAEFJ7890Q1Z7', email: 'jaihindfuels@demo.in', city: 'Washim', bank: { name: 'Jai Hind Fuels', no: '22770088990011', ifsc: 'BARB0WASHIM' } },
  { key: 'crane', name: 'Sai Crane Services', kind: 'vendor', gstin: '27ABUPS9012S1Z9', email: 'saicrane@demo.in', city: 'Akola', bank: { name: 'Sai Crane Services', no: '33880099001122', ifsc: 'HDFC0007788' } },
  { key: 'power', name: 'MSEDCL Washim Division', kind: 'vendor', email: 'washim@msedcl.demo', city: 'Washim' },
  { key: 'landlord', name: 'Deshpande Properties', kind: 'vendor', gstin: '27AAHFD4321E1Z3', email: 'deshpande.prop@demo.in', city: 'Washim', tdsSection: '194I', bank: { name: 'Deshpande Properties', no: '44990011223344', ifsc: 'SBIN0004455' } },
  { key: 'ca', name: 'Joshi and Associates, Chartered Accountants', kind: 'vendor', gstin: '27AAJFJ6543D1Z1', email: 'ca.joshi@demo.in', city: 'Akola', tdsSection: '194J', bank: { name: 'Joshi and Associates', no: '55001122334455', ifsc: 'HDFC0002468' } },
  { key: 'earthmovers', name: 'Vidarbha Earthmovers', kind: 'vendor', gstin: '27AAFCV7654G1Z2', email: 'sales@vearthmovers.demo', city: 'Nagpur' },
  { key: 'motors', name: 'Shri Motors Akola', kind: 'vendor', gstin: '27AAKFS8765H1Z4', email: 'sales@shrimotors.demo', city: 'Akola' },
  { key: 'computers', name: 'Techno Computers Akola', kind: 'vendor', gstin: '27AAOPT9876J1Z6', email: 'techno@demo.in', city: 'Akola' },
  // subcontractors and labour contractors
  { key: 'kale', name: 'Kale Constructions', kind: 'subcontractor', gstin: '27ABCPK1234L1Z5', pan: 'ABCPK1234L', email: 'site@kale.demo', city: 'Washim', tdsSection: '194C', bank: { name: 'Kale Constructions', no: '66112233445566', ifsc: 'MAHB0001212' } },
  { key: 'shaikh', name: 'Shaikh Labour Services', kind: 'subcontractor', gstin: '27ACXPS2345T1Z1', pan: 'ACXPS2345T', email: 'shaikh.labour@demo.in', city: 'Akola', tdsSection: '194C', bank: { name: 'Shaikh Labour Services', no: '77223344556677', ifsc: 'SBIN0003344' } },
  { key: 'mep', name: 'Vidarbha Electricals and Plumbing', kind: 'subcontractor', gstin: '27AAEFV3456U1Z2', pan: 'AAEFV3456U', email: 'vep@demo.in', city: 'Akola', tdsSection: '194C', bank: { name: 'Vidarbha Electricals and Plumbing', no: '88334455667788', ifsc: 'ICIC0002244' } },
  // competitors
  { key: 'c1', name: 'Patil Buildcon', kind: 'competitor' },
  { key: 'c2', name: 'Raut Infra Projects', kind: 'competitor' },
  { key: 'c3', name: 'Shree Ganesh Constructions', kind: 'competitor' },
  { key: 'c4', name: 'Mahalaxmi Builders', kind: 'competitor' },
  { key: 'c5', name: 'Agrawal Infratech', kind: 'competitor' },
];

// --- staff: ten on the rolls today; three more came and went ---
export interface StaffPlan {
  code: string;
  username: string;
  name: string;
  role: 'manager' | 'worker';
  designation: string;
  department: string;
  gender: 'male' | 'female';
  joinedOn: Day;
  left?: { on: Day; reason: 'resigned' | 'terminated'; noticeDays: string };
  /** Monthly gross on joining; raised every April. */
  gross: number;
  /** 'office' or the site engineers who follow the projects. */
  post: 'office' | 'site';
  pan: string;
  birthDate: Day;
  what: string;
}
export const STAFF: StaffPlan[] = [
  { code: 'DI001', username: 'suresh', name: 'Suresh Patil', role: 'manager', designation: 'Projects manager', department: 'Projects', gender: 'male', joinedOn: '2024-01-02', gross: 60000, post: 'office', pan: 'BQRPP1234A', birthDate: '1982-06-14', what: 'projects manager: projects, purchase, site, cost' },
  { code: 'DI002', username: 'priya', name: 'Priya Kulkarni', role: 'manager', designation: 'Estimation and contracts manager', department: 'Estimation', gender: 'female', joinedOn: '2024-01-02', gross: 55000, post: 'office', pan: 'CKLPK2345B', birthDate: '1987-09-02', what: 'estimation, tenders, CRM, contracts, sales and RERA' },
  { code: 'DI003', username: 'kavita', name: 'Kavita Bhosale', role: 'manager', designation: 'Accounts executive', department: 'Accounts', gender: 'female', joinedOn: '2024-01-15', gross: 30000, post: 'office', pan: 'DMNPB3456C', birthDate: '1991-02-21', what: 'accounts: vouchers, bills, payments, GST, TDS, bank' },
  { code: 'DI004', username: 'raju', name: 'Raju Wankhede', role: 'worker', designation: 'Site engineer', department: 'Site', gender: 'male', joinedOn: '2024-02-01', gross: 28000, post: 'site', pan: 'BKLPW4321M', birthDate: '1993-11-05', what: 'site engineer: daily reports, measurements, attendance' },
  { code: 'DI005', username: 'meena', name: 'Meena Joshi', role: 'worker', designation: 'Site supervisor', department: 'Site', gender: 'female', joinedOn: '2024-03-01', gross: 20000, post: 'site', pan: 'EPQPJ5678D', birthDate: '1995-04-17', what: 'site supervisor: daily reports, muster, stores' },
  { code: 'DI006', username: 'imran', name: 'Imran Shaikh', role: 'manager', designation: 'Purchase and stores officer', department: 'Purchase', gender: 'male', joinedOn: '2024-02-15', gross: 28000, post: 'office', pan: 'FRSPS6789E', birthDate: '1989-12-30', what: 'purchase: requisitions, enquiries, orders, stores' },
  { code: 'DI007', username: 'sachin', name: 'Sachin Gawande', role: 'worker', designation: 'Site engineer', department: 'Site', gender: 'male', joinedOn: '2024-04-01', left: { on: '2025-06-30', reason: 'resigned', noticeDays: '0' }, gross: 26000, post: 'site', pan: 'GTUPG7890F', birthDate: '1994-03-08', what: 'site engineer (resigned June 2025; sign-in turned off)' },
  { code: 'DI008', username: 'pooja', name: 'Pooja Wankhade', role: 'manager', designation: 'HR and admin executive', department: 'HR and admin', gender: 'female', joinedOn: '2024-04-15', gross: 22000, post: 'office', pan: 'HVWPW8901G', birthDate: '1996-07-11', what: 'HR: employees, attendance, leave, payroll, labour' },
  { code: 'DI009', username: 'ganesh', name: 'Ganesh Pawar', role: 'worker', designation: 'Safety and quality officer', department: 'QA/QC and safety', gender: 'male', joinedOn: '2024-06-01', left: { on: '2025-02-28', reason: 'terminated', noticeDays: '-15' }, gross: 24000, post: 'site', pan: 'JXYPP9012H', birthDate: '1990-01-19', what: 'safety and quality officer (terminated February 2025; sign-in turned off)' },
  { code: 'DI010', username: 'vijay', name: 'Vijay Kale', role: 'worker', designation: 'Store keeper', department: 'Stores', gender: 'male', joinedOn: '2024-08-01', left: { on: '2026-05-31', reason: 'resigned', noticeDays: '0' }, gross: 16000, post: 'site', pan: 'KZAPK0123J', birthDate: '1997-10-23', what: 'store keeper (resigned May 2026; sign-in turned off)' },
  { code: 'DI011', username: 'nikhil', name: 'Nikhil Thakare', role: 'worker', designation: 'Site engineer', department: 'Site', gender: 'male', joinedOn: '2025-07-14', gross: 26000, post: 'site', pan: 'LBCPT1234K', birthDate: '1996-05-29', what: 'site engineer: daily reports, measurements, quality' },
  { code: 'DI012', username: 'rahul', name: 'Rahul Ingole', role: 'manager', designation: 'QA/QC and safety officer', department: 'QA/QC and safety', gender: 'male', joinedOn: '2025-03-17', gross: 26000, post: 'site', pan: 'MDEPI2345L', birthDate: '1992-08-15', what: 'quality and safety: inspections, tests, NCRs, incidents, permits' },
  { code: 'DI013', username: 'snehal', name: 'Snehal Dhote', role: 'worker', designation: 'Junior site engineer', department: 'Site', gender: 'female', joinedOn: '2026-01-05', gross: 18000, post: 'site', pan: 'NFGPD3456M', birthDate: '1999-02-03', what: 'junior site engineer: daily reports, muster' },
];

// --- the rate library: rates on 1 December 2023, escalated each quarter ---
export interface ResourcePlan {
  code: string;
  name: string;
  kind: 'material' | 'labour' | 'equipment';
  unit: string;
  rate: number;
  /** Supplier and GST for materials bought on orders. */
  vendor?: string;
  gst?: number;
  hsn?: string;
}
export const RESOURCES: ResourcePlan[] = [
  { code: 'M-CEM', name: 'Cement OPC 53 grade', kind: 'material', unit: 'bag', rate: 360, vendor: 'cement', gst: 28, hsn: '2523' },
  { code: 'M-STL', name: 'TMT bars Fe 500D', kind: 'material', unit: 't', rate: 58000, vendor: 'steel', gst: 18, hsn: '7214' },
  { code: 'M-SND', name: 'Crushed sand', kind: 'material', unit: 'cum', rate: 1900, vendor: 'sand', gst: 5, hsn: '2505' },
  { code: 'M-A20', name: 'Aggregate 20 mm', kind: 'material', unit: 'cum', rate: 1500, vendor: 'sand', gst: 5, hsn: '2517' },
  { code: 'M-A10', name: 'Aggregate 10 mm', kind: 'material', unit: 'cum', rate: 1550, vendor: 'sand', gst: 5, hsn: '2517' },
  { code: 'M-BRK', name: 'Fly-ash bricks', kind: 'material', unit: 'nos', rate: 6.5, vendor: 'bricks', gst: 5, hsn: '6901' },
  { code: 'M-TIL', name: 'Vitrified tiles 600 x 600', kind: 'material', unit: 'sqm', rate: 520, vendor: 'tiles', gst: 18, hsn: '6907' },
  { code: 'M-PNT', name: 'Acrylic emulsion paint', kind: 'material', unit: 'ltr', rate: 210, vendor: 'paints', gst: 18, hsn: '3209' },
  { code: 'M-WPC', name: 'Waterproofing compound', kind: 'material', unit: 'kg', rate: 95, vendor: 'paints', gst: 18, hsn: '3824' },
  { code: 'M-PLY', name: 'Shuttering plywood (per use)', kind: 'material', unit: 'sqm', rate: 75, vendor: 'hardware', gst: 18, hsn: '4412' },
  { code: 'M-BWR', name: 'Binding wire', kind: 'material', unit: 'kg', rate: 72, vendor: 'hardware', gst: 18, hsn: '7217' },
  { code: 'M-DSL', name: 'High-speed diesel', kind: 'material', unit: 'ltr', rate: 92 },
  { code: 'L-MSN', name: 'Mason', kind: 'labour', unit: 'day', rate: 750 },
  { code: 'L-HLP', name: 'Helper', kind: 'labour', unit: 'day', rate: 450 },
  { code: 'L-CRP', name: 'Carpenter', kind: 'labour', unit: 'day', rate: 750 },
  { code: 'L-BBD', name: 'Bar bender', kind: 'labour', unit: 'day', rate: 700 },
  { code: 'L-PTR', name: 'Painter', kind: 'labour', unit: 'day', rate: 650 },
  { code: 'L-TIL', name: 'Tile fixer', kind: 'labour', unit: 'day', rate: 750 },
  { code: 'E-JCB', name: 'JCB backhoe loader', kind: 'equipment', unit: 'hour', rate: 1100 },
  { code: 'E-MIX', name: 'Concrete mixer 10/7', kind: 'equipment', unit: 'day', rate: 1200 },
  { code: 'E-VIB', name: 'Needle vibrator', kind: 'equipment', unit: 'day', rate: 350 },
];

type Line = [code: string, qty: number] | ['LS', number, string];
export interface AnalysisPlan {
  code: string;
  description: string;
  unit: string;
  outputQty: number;
  lines: Line[];
}
export const ANALYSES: AnalysisPlan[] = [
  { code: 'RA-EXC', description: 'Excavation in ordinary soil by machine, including disposal within 50 m', unit: 'cum', outputQty: 100, lines: [['E-JCB', 4], ['L-HLP', 6], ['LS', 4000, 'Dewatering and disposal']] },
  { code: 'RA-PCC', description: 'Plain cement concrete M15 (1:2:4) in foundations', unit: 'cum', outputQty: 1, lines: [['M-CEM', 6.4], ['M-SND', 0.45], ['M-A20', 0.9], ['L-MSN', 0.1], ['L-HLP', 1.6], ['E-MIX', 0.07]] },
  { code: 'RA-RCC', description: 'Reinforced cement concrete M25 in columns, beams and slabs (excluding steel and shuttering)', unit: 'cum', outputQty: 1, lines: [['M-CEM', 8.2], ['M-SND', 0.44], ['M-A20', 0.6], ['M-A10', 0.3], ['L-MSN', 0.17], ['L-HLP', 2], ['E-MIX', 0.07], ['E-VIB', 0.07]] },
  { code: 'RA-STL', description: 'Reinforcement steel Fe 500D, cut, bent and placed', unit: 't', outputQty: 1, lines: [['M-STL', 1.025], ['M-BWR', 8], ['L-BBD', 4], ['L-HLP', 4]] },
  { code: 'RA-SHT', description: 'Centering and shuttering for slabs, beams and columns', unit: 'sqm', outputQty: 10, lines: [['M-PLY', 10], ['L-CRP', 1.5], ['L-HLP', 1.5], ['LS', 600, 'Props, nails and oil']] },
  { code: 'RA-BRK', description: 'Fly-ash brick masonry 230 mm in CM 1:6', unit: 'cum', outputQty: 1, lines: [['M-BRK', 500], ['M-CEM', 1.3], ['M-SND', 0.3], ['L-MSN', 0.7], ['L-HLP', 1.2]] },
  { code: 'RA-PLS', description: 'Internal cement plaster 12 mm in CM 1:6', unit: 'sqm', outputQty: 10, lines: [['M-CEM', 1.1], ['M-SND', 0.16], ['L-MSN', 1], ['L-HLP', 1]] },
  { code: 'RA-EPL', description: 'External sand-faced plaster 20 mm in CM 1:4 with waterproofing', unit: 'sqm', outputQty: 10, lines: [['M-CEM', 2.3], ['M-SND', 0.27], ['M-WPC', 1], ['L-MSN', 1.2], ['L-HLP', 1.4]] },
  { code: 'RA-TIL', description: 'Vitrified tile flooring 600 x 600 on CM 1:4 bed', unit: 'sqm', outputQty: 10, lines: [['M-TIL', 10.5], ['M-CEM', 1.5], ['M-SND', 0.25], ['L-TIL', 1], ['L-HLP', 1]] },
  { code: 'RA-PNT', description: 'Acrylic emulsion paint, two coats over putty and primer', unit: 'sqm', outputQty: 100, lines: [['M-PNT', 18], ['L-PTR', 5], ['L-HLP', 2], ['LS', 2500, 'Putty and primer']] },
  { code: 'RA-WPF', description: 'Terrace waterproofing with brickbat coba and compound', unit: 'sqm', outputQty: 10, lines: [['M-WPC', 15], ['M-CEM', 1], ['M-SND', 0.1], ['L-MSN', 0.6], ['L-HLP', 1.2]] },
];

/** The building BOQ every tender starts from; quantities are per ₹1 crore of work and scaled to each tender. */
export interface BoqItemPlan {
  code: string;
  section: string;
  analysis?: string;
  description?: string;
  unit?: string;
  qty: number;
  /** Lump-sum items: a share of the contract value. */
  share?: number;
  provisional?: boolean;
  /** When in the job the work is done (fractions of the duration). */
  window: [number, number];
  /** The labour contractor's rate per unit (work orders), when labour is sublet. */
  labourRate?: number;
}
export const BOQ_SECTIONS: [code: string, name: string][] = [
  ['1', 'Earthwork'],
  ['2', 'Concrete and reinforcement'],
  ['3', 'Masonry'],
  ['4', 'Finishes'],
  ['5', 'Building services'],
];
export const BOQ_ITEMS: BoqItemPlan[] = [
  { code: '1.1', section: '1', analysis: 'RA-EXC', qty: 900, window: [0, 0.14] },
  { code: '2.1', section: '2', analysis: 'RA-PCC', qty: 60, window: [0.05, 0.2], labourRate: 450 },
  { code: '2.2', section: '2', analysis: 'RA-RCC', qty: 420, window: [0.1, 0.68], labourRate: 950 },
  { code: '2.3', section: '2', analysis: 'RA-STL', qty: 38, window: [0.1, 0.68], labourRate: 6500 },
  { code: '2.4', section: '2', analysis: 'RA-SHT', qty: 2600, window: [0.1, 0.68], labourRate: 110 },
  { code: '3.1', section: '3', analysis: 'RA-BRK', qty: 260, window: [0.3, 0.8], labourRate: 1100 },
  { code: '4.1', section: '4', analysis: 'RA-PLS', qty: 4800, window: [0.5, 0.9], labourRate: 85 },
  { code: '4.2', section: '4', analysis: 'RA-EPL', qty: 1500, window: [0.55, 0.92], labourRate: 120 },
  { code: '4.3', section: '4', analysis: 'RA-TIL', qty: 1100, window: [0.65, 0.95], labourRate: 140 },
  { code: '4.4', section: '4', analysis: 'RA-PNT', qty: 6000, window: [0.75, 1], labourRate: 45 },
  { code: '4.5', section: '4', analysis: 'RA-WPF', qty: 500, window: [0.7, 0.9], labourRate: 90 },
  { code: '5.1', section: '5', description: 'Internal electrification: wiring, fittings and DB, complete', unit: 'LS', qty: 1, share: 0.06, window: [0.4, 1] },
  { code: '5.2', section: '5', description: 'Plumbing, sanitary fittings and drainage, complete', unit: 'LS', qty: 1, share: 0.05, window: [0.4, 1] },
  { code: '5.3', section: '5', description: 'Provisional sum: external development', unit: 'LS', qty: 1, share: 0.02, provisional: true, window: [0.85, 1] },
];

// --- tenders and projects ---
export interface ProjectPlan {
  key: string;
  name: string;
  client: string;
  location: string;
  /** Target contract value (before GST). */
  value: number;
  vertical?: 'buildings';
  published: Day;
  submitted: Day;
  result: Day;
  start: Day;
  plannedFinish: Day;
  /** Completed on; absent while running. */
  finished?: Day;
  /** Work runs late by this share of the planned duration. */
  slip: number;
  masonry?: 'brick';
  site: string;
  engineer: string;
  supervisor?: string;
  labour: string[];
  retentionPct: number;
  advancePct?: number;
  competitors: [string, number][];
  lead?: { source: 'referral' | 'repeat_client' | 'website' | 'portal' | 'event'; on: Day };
}
export const PROJECTS: ProjectPlan[] = [
  { key: 'p1', name: 'ZP Primary School Classrooms, Malegaon', client: 'zp', location: 'Malegaon, Washim', value: 9_500_000, published: '2024-01-08', submitted: '2024-01-24', result: '2024-02-01', start: '2024-02-05', plannedFinish: '2024-09-30', finished: '2024-10-15', slip: 0.06, site: 'Malegaon school site', engineer: 'raju', supervisor: 'meena', labour: ['kale'], retentionPct: 5, competitors: [['c1', 1.04], ['c3', 1.07]] },
  { key: 'p2', name: 'Gram Panchayat Office, Risod', client: 'gpRisod', location: 'Risod, Washim', value: 7_000_000, published: '2024-02-20', submitted: '2024-03-08', result: '2024-03-22', start: '2024-04-01', plannedFinish: '2024-12-20', finished: '2024-12-27', slip: 0.02, site: 'Risod GP site', engineer: 'sachin', labour: ['shaikh'], retentionPct: 5, competitors: [['c2', 1.03], ['c4', 1.09]], lead: { source: 'repeat_client', on: '2024-02-05' } },
  { key: 'p3', name: 'PHC Staff Quarters, Karanja', client: 'pwd', location: 'Karanja, Washim', value: 13_000_000, published: '2024-08-12', submitted: '2024-08-30', result: '2024-09-18', start: '2024-10-01', plannedFinish: '2025-07-31', finished: '2025-08-20', slip: 0.07, site: 'Karanja quarters site', engineer: 'raju', supervisor: 'meena', labour: ['kale', 'mep'], retentionPct: 5, competitors: [['c1', 1.02], ['c5', 1.05], ['c3', 1.08]] },
  { key: 'p4', name: 'APMC Warehouse, Mangrulpir', client: 'apmc', location: 'Mangrulpir, Washim', value: 11_000_000, published: '2025-01-10', submitted: '2025-01-28', result: '2025-02-14', start: '2025-03-01', plannedFinish: '2025-12-15', finished: '2025-12-28', slip: 0.04, site: 'Mangrulpir warehouse site', engineer: 'sachin', labour: ['shaikh'], retentionPct: 5, competitors: [['c2', 1.01], ['c4', 1.06]], lead: { source: 'website', on: '2024-12-02' } },
  { key: 'p5', name: 'Taluka Court Annexe, Mangrulpir', client: 'pwd', location: 'Mangrulpir, Washim', value: 8_500_000, published: '2025-06-02', submitted: '2025-06-20', result: '2025-07-15', start: '2025-08-01', plannedFinish: '2026-07-31', finished: '2026-08-25', slip: 0.08, site: 'Court annexe site', engineer: 'nikhil', labour: ['shaikh', 'mep'], retentionPct: 5, competitors: [['c1', 1.03], ['c5', 1.04]] },
  { key: 'p6', name: 'Hostel Block, Amravati', client: 'sss', location: 'Amravati', value: 10_500_000, published: '2025-07-25', submitted: '2025-08-12', result: '2025-09-01', start: '2025-09-15', plannedFinish: '2026-09-10', finished: '2026-09-20', slip: 0.03, site: 'Amravati hostel site', engineer: 'raju', supervisor: 'meena', labour: ['kale', 'mep'], retentionPct: 5, advancePct: 10, competitors: [['c3', 1.05], ['c4', 1.02]], lead: { source: 'referral', on: '2025-05-20' } },
  { key: 'p7', name: 'Zilla Parishad School, Washim', client: 'zp', location: 'Washim', value: 7_500_000, published: '2025-11-20', submitted: '2025-12-08', result: '2025-12-24', start: '2026-01-05', plannedFinish: '2026-11-30', slip: 0.04, site: 'Washim main site', engineer: 'snehal', supervisor: 'meena', labour: ['kale'], retentionPct: 5, competitors: [['c1', 1.03], ['c2', 1.05]] },
  { key: 'p8', name: 'Community Hall, Akola', client: 'amc', location: 'Akola', value: 6_000_000, published: '2026-01-05', submitted: '2026-01-19', result: '2026-01-27', start: '2026-02-02', plannedFinish: '2026-12-15', slip: 0.05, site: 'Akola community hall site', engineer: 'nikhil', labour: ['shaikh'], retentionPct: 5, competitors: [['c5', 1.02], ['c4', 1.04]], lead: { source: 'portal', on: '2025-12-10' } },
  { key: 'p9', name: 'Sub-district Hospital OPD Block, Malkapur', client: 'health', location: 'Malkapur, Buldhana', value: 14_000_000, published: '2026-03-16', submitted: '2026-04-06', result: '2026-04-24', start: '2026-05-04', plannedFinish: '2027-06-30', slip: 0.03, site: 'Malkapur hospital site', engineer: 'raju', supervisor: 'meena', labour: ['kale', 'mep'], retentionPct: 5, advancePct: 10, competitors: [['c1', 1.01], ['c3', 1.04], ['c5', 1.06]] },
  { key: 'p10', name: 'Police Staff Quarters, Washim', client: 'police', location: 'Washim', value: 11_000_000, published: '2026-05-25', submitted: '2026-06-15', result: '2026-07-08', start: '2026-08-03', plannedFinish: '2027-08-31', slip: 0.02, site: 'Police quarters site', engineer: 'snehal', labour: ['shaikh'], retentionPct: 5, competitors: [['c2', 1.02], ['c4', 1.05]], lead: { source: 'event', on: '2026-04-15' } },
];

/** Tenders the company bid and lost, chose not to bid, or still has open. */
export interface TenderPlan {
  title: string;
  client: string;
  location: string;
  value: number;
  published: Day;
  due: Day;
  outcome: 'lost' | 'no_bid' | 'bidding' | 'submitted' | 'evaluating';
  result?: Day;
  winner?: string;
  ourFactor?: number;
  category?: 'price' | 'technical' | 'qualification';
}
export const OTHER_TENDERS: TenderPlan[] = [
  { title: 'Anganwadi buildings, Washim taluka (8 nos)', client: 'zp', location: 'Washim', value: 4_200_000, published: '2024-02-12', due: '2024-02-28', outcome: 'lost', result: '2024-03-15', winner: 'c3', ourFactor: 1.06, category: 'price' },
  { title: 'Ward office, Akola east zone', client: 'amc', location: 'Akola', value: 9_800_000, published: '2024-05-06', due: '2024-05-24', outcome: 'lost', result: '2024-06-12', winner: 'c5', ourFactor: 1.04, category: 'price' },
  { title: 'Rural hospital extension, Risod', client: 'health', location: 'Risod', value: 21_000_000, published: '2024-06-17', due: '2024-07-05', outcome: 'no_bid' },
  { title: 'Girls hostel, Karanja', client: 'sss', location: 'Karanja', value: 12_500_000, published: '2024-07-08', due: '2024-07-26', outcome: 'lost', result: '2024-08-20', winner: 'c4', ourFactor: 1.03, category: 'price' },
  { title: 'Cold storage shed, Washim APMC', client: 'apmc', location: 'Washim', value: 6_800_000, published: '2024-10-14', due: '2024-10-30', outcome: 'lost', result: '2024-11-22', winner: 'c2', ourFactor: 1.05, category: 'price' },
  { title: 'Primary school, Manora', client: 'zp', location: 'Manora', value: 5_600_000, published: '2024-11-11', due: '2024-11-27', outcome: 'lost', result: '2024-12-16', winner: 'c1', ourFactor: 1.02, category: 'technical' },
  { title: 'Fire station building, Akola', client: 'amc', location: 'Akola', value: 16_500_000, published: '2025-03-17', due: '2025-04-04', outcome: 'lost', result: '2025-04-28', winner: 'c5', ourFactor: 1.07, category: 'price' },
  { title: 'Police outpost, Malegaon', client: 'police', location: 'Malegaon', value: 4_800_000, published: '2025-04-21', due: '2025-05-09', outcome: 'lost', result: '2025-05-30', winner: 'c3', ourFactor: 1.04, category: 'qualification' },
  { title: 'District court record room, Washim', client: 'pwd', location: 'Washim', value: 7_200_000, published: '2025-09-08', due: '2025-09-26', outcome: 'lost', result: '2025-10-17', winner: 'c1', ourFactor: 1.03, category: 'price' },
  { title: 'Trauma care unit, Buldhana', client: 'health', location: 'Buldhana', value: 32_000_000, published: '2025-10-06', due: '2025-10-24', outcome: 'no_bid' },
  { title: 'Vegetable market sheds, Mangrulpir', client: 'apmc', location: 'Mangrulpir', value: 5_400_000, published: '2026-02-09', due: '2026-02-27', outcome: 'lost', result: '2026-03-20', winner: 'c2', ourFactor: 1.05, category: 'price' },
  { title: 'Teachers quarters, Amravati campus', client: 'sss', location: 'Amravati', value: 9_200_000, published: '2026-06-08', due: '2026-06-26', outcome: 'lost', result: '2026-07-22', winner: 'c4', ourFactor: 1.02, category: 'price' },
  { title: 'Gram panchayat office, Seloo', client: 'gpRisod', location: 'Seloo', value: 5_200_000, published: '2026-08-24', due: '2026-09-11', outcome: 'submitted', ourFactor: 1.0 },
  { title: 'Primary health centre, Risod', client: 'zp', location: 'Risod', value: 18_500_000, published: '2026-09-21', due: '2026-10-27', outcome: 'bidding' },
  { title: 'Swimming pool complex, Akola', client: 'amc', location: 'Akola', value: 26_000_000, published: '2026-10-05', due: '2026-11-06', outcome: 'evaluating' },
];

/** CRM leads that never reached a tender, and open ones for the pipeline. */
export const OTHER_LEADS: {
  title: string;
  organisation: string;
  source: 'referral' | 'repeat_client' | 'website' | 'cold_call' | 'event' | 'portal' | 'other';
  segment: 'buildings' | 'interiors' | 'real_estate' | 'other';
  value: string;
  on: Day;
  end: 'lost' | 'dropped' | 'qualified' | 'proposal' | 'negotiation' | 'new';
  expected: string;
}[] = [
  { title: 'Showroom fit-out, Akola', organisation: 'Auto Plaza Motors', source: 'website', segment: 'interiors', value: '6500000', on: '2024-04-10', end: 'lost', expected: '2024-07' },
  { title: 'Cotton ginning shed', organisation: 'Vidarbha Cotton Ginners', source: 'cold_call', segment: 'buildings', value: '8500000', on: '2024-09-03', end: 'dropped', expected: '2025-01' },
  { title: 'School auditorium, Washim', organisation: 'Saraswati Education Society', source: 'referral', segment: 'buildings', value: '12000000', on: '2025-02-11', end: 'lost', expected: '2025-06' },
  { title: 'Bank branch interiors, Karanja', organisation: 'Vidarbha Konkan Gramin Bank', source: 'event', segment: 'interiors', value: '3200000', on: '2025-08-19', end: 'dropped', expected: '2025-11' },
  { title: 'Hostel block for the engineering college', organisation: 'Shivaji Shikshan Sanstha', source: 'referral', segment: 'buildings', value: '42000000', on: '2026-07-14', end: 'negotiation', expected: '2026-12' },
  { title: 'Warehouse for agro-processing unit', organisation: 'Kisan Agro Foods', source: 'website', segment: 'buildings', value: '15000000', on: '2026-08-22', end: 'proposal', expected: '2027-01' },
  { title: 'Clinic building, Malkapur', organisation: 'Dr. Bhagat Hospital Trust', source: 'repeat_client', segment: 'buildings', value: '9500000', on: '2026-09-10', end: 'qualified', expected: '2027-02' },
  { title: 'Row houses, Washim (phase 2)', organisation: 'Deshmukh Infra (own development)', source: 'other', segment: 'real_estate', value: '60000000', on: '2026-09-28', end: 'new', expected: '2027-04' },
];

// --- labour: three contractors supply the workers ---
export const LABOUR_CONTRACTORS: Record<string, { licenceNo: string; workers: number; trades: [string, 'unskilled' | 'semi_skilled' | 'skilled', number][] }> = {
  kale: { licenceNo: 'CLRA/WSM/2023/114', workers: 120, trades: [['Mason', 'skilled', 750], ['Helper', 'unskilled', 450], ['Bar bender', 'semi_skilled', 650], ['Carpenter', 'skilled', 750]] },
  shaikh: { licenceNo: 'CLRA/AKL/2023/287', workers: 90, trades: [['Mason', 'skilled', 730], ['Helper', 'unskilled', 440], ['Tile fixer', 'skilled', 760], ['Painter', 'semi_skilled', 640]] },
  mep: { licenceNo: 'CLRA/AKL/2024/031', workers: 40, trades: [['Electrician', 'skilled', 800], ['Plumber', 'skilled', 780], ['Helper', 'unskilled', 450]] },
};
export const FIRST_NAMES = ['Ramesh', 'Suresh', 'Ganesh', 'Mahesh', 'Dinesh', 'Santosh', 'Prakash', 'Vilas', 'Anil', 'Sunil', 'Ravi', 'Vijay', 'Sanjay', 'Ajay', 'Manoj', 'Nitin', 'Sachin', 'Amol', 'Rahul', 'Rajesh', 'Shankar', 'Bhimrao', 'Dnyaneshwar', 'Pandurang', 'Sopan', 'Vitthal', 'Kailas', 'Balu', 'Gopal', 'Raju', 'Shivaji', 'Tukaram', 'Namdeo', 'Ashok', 'Datta', 'Kishor', 'Pravin', 'Yogesh', 'Sandip', 'Umesh', 'Laxmi', 'Sunita', 'Kamal', 'Shobha', 'Mangala', 'Sangita', 'Rekha', 'Asha', 'Usha', 'Savita'];
export const LAST_NAMES = ['Pawar', 'Jadhav', 'Shinde', 'Wankhede', 'Ingle', 'Gawande', 'Thakare', 'Bhagat', 'Raut', 'Kale', 'Sonone', 'Kharat', 'Khandare', 'Tayde', 'Wagh', 'More', 'Gaikwad', 'Bansod', 'Meshram', 'Dhore', 'Rathod', 'Chavan', 'Mankar', 'Sawant', 'Bhise', 'Gote', 'Lokhande', 'Patil', 'Khade', 'Ghuge'];

/** Machines the company owns, bought in its first months, and one it hires. */
export const MACHINES = [
  { code: 'JCB-01', name: 'JCB 3DX backhoe loader', category: 'excavator' as const, meter: 'hours' as const, cost: 3_400_000, bought: '2024-02-10', vendor: 'earthmovers', cls: 'Construction equipment', internalRate: 1100, fuelNorm: '6' },
  { code: 'MIX-01', name: 'Concrete mixer 10/7 (1)', category: 'mixer' as const, meter: 'hours' as const, cost: 160_000, bought: '2024-02-12', vendor: 'earthmovers', cls: 'Construction equipment', internalRate: 150, fuelNorm: '1.2' },
  { code: 'MIX-02', name: 'Concrete mixer 10/7 (2)', category: 'mixer' as const, meter: 'hours' as const, cost: 165_000, bought: '2024-09-20', vendor: 'earthmovers', cls: 'Construction equipment', internalRate: 150, fuelNorm: '1.2' },
  { code: 'VEH-01', name: 'Mahindra Bolero pickup MH37 T 4521', category: 'vehicle' as const, meter: 'km' as const, cost: 950_000, bought: '2024-02-20', vendor: 'motors', cls: 'Motor vehicles', internalRate: 18, fuelNorm: '0.08' },
];
export const OFFICE_ASSETS = [
  { name: 'Laptops for the office (4 nos)', cost: 240_000, bought: '2024-01-20', vendor: 'computers', cls: 'Computers' },
  { name: 'Office furniture, Washim office', cost: 260_000, bought: '2024-01-25', vendor: 'computers', cls: 'Furniture and fittings' },
  { name: 'Total station survey instrument', cost: 310_000, bought: '2024-03-05', vendor: 'earthmovers', cls: 'Plant and machinery' },
];

/** Maharashtra public holidays used for the office and site calendars. */
export const HOLIDAYS: [Day, string][] = [
  ['2024-01-26', 'Republic Day'], ['2024-03-08', 'Mahashivratri'], ['2024-03-25', 'Holi'], ['2024-04-09', 'Gudi Padwa'], ['2024-05-01', 'Maharashtra Day'], ['2024-08-15', 'Independence Day'], ['2024-09-07', 'Ganesh Chaturthi'], ['2024-10-02', 'Gandhi Jayanti'], ['2024-10-12', 'Dussehra'], ['2024-11-01', 'Diwali (Laxmi Puja)'], ['2024-11-02', 'Diwali (Balipratipada)'], ['2024-12-25', 'Christmas'],
  ['2025-01-26', 'Republic Day'], ['2025-02-19', 'Shivaji Maharaj Jayanti'], ['2025-02-26', 'Mahashivratri'], ['2025-03-14', 'Holi'], ['2025-03-30', 'Gudi Padwa'], ['2025-05-01', 'Maharashtra Day'], ['2025-08-15', 'Independence Day'], ['2025-08-27', 'Ganesh Chaturthi'], ['2025-10-02', 'Gandhi Jayanti and Dussehra'], ['2025-10-21', 'Diwali (Laxmi Puja)'], ['2025-10-22', 'Diwali (Balipratipada)'], ['2025-12-25', 'Christmas'],
  ['2026-01-26', 'Republic Day'], ['2026-02-19', 'Shivaji Maharaj Jayanti'], ['2026-03-04', 'Holi'], ['2026-03-19', 'Gudi Padwa'], ['2026-05-01', 'Maharashtra Day'], ['2026-08-15', 'Independence Day'], ['2026-09-14', 'Ganesh Chaturthi'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali (Laxmi Puja)'], ['2026-12-25', 'Christmas'],
];
