// Bulk imports (docs/wave7-plan.md step 7c.8): parties, employees, contract workers or resources from an Excel sheet,
// checked row by row first, then saved; rows that cannot be saved are listed with the reason.
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Table } from '@aerolith/ui';
import { useState } from 'react';
import { api } from '../api/client';
import { useCompany } from '../accounts/model';
import { describeError } from '../lib/format';

type Kind = 'parties' | 'employees' | 'workers' | 'resources';
const KINDS: Record<Kind, { label: string; columns: string }> = {
  parties: {
    label: 'Parties',
    columns:
      'Name; Kind (client, vendor, subcontractor); GSTIN; PAN; Contact; Email; Phone; Address; City',
  },
  employees: {
    label: 'Employees',
    columns:
      'Code; Name; Date of joining; Kind (staff or worker); Department; Grade; Phone; Email; PAN; UAN; Bank account; IFSC',
  },
  workers: {
    label: 'Contract workers',
    columns: 'Contractor; Name; Father or husband; Trade; Skill; Daily wage; Date of joining',
  },
  resources: { label: 'Resources', columns: 'Code; Name; Type; Unit; Rate; Rate from' },
};
interface Result {
  rows: {
    rowNo: number;
    values: Record<string, unknown>;
    problem: string | null;
    saved?: boolean;
  }[];
  saved: number;
  failed: number;
  applied: boolean;
}

export function ImportsScreen() {
  const { company, companies } = useCompany();
  const [kind, setKind] = useState<Kind>('parties');
  const [entityId, setEntityId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (apply: boolean) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    const company_ = entityId || company?.id || '';
    try {
      setResult(
        await api.upload<Result>(
          `/api/tenant/imports/${kind}?apply=${apply}${kind === 'employees' && company_ ? `&entityId=${company_}` : ''}`,
          file,
        ),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const first = result?.rows[0]?.values ?? {};
  const fields = Object.keys(first);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Imports"
        subtitle="Bring in parties, employees, contract workers or resources from an Excel sheet."
      />
      <Card>
        <form
          aria-label="Import"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(false);
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <Field label="What">
              <Select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Kind);
                  setResult(null);
                }}
              >
                {(Object.keys(KINDS) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {KINDS[k].label}
                  </option>
                ))}
              </Select>
            </Field>
            {kind === 'employees' ? (
              <Field label="Company">
                <Select
                  value={entityId || company?.id || ''}
                  onChange={(e) => setEntityId(e.target.value)}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Excel workbook (.xlsx)">
              <Input
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
            </Field>
            <Button type="submit" disabled={!file || busy}>
              Check the sheet
            </Button>
          </div>
          <p className="text-xs text-fg-muted">Columns, in the first row: {KINDS[kind].columns}.</p>
        </form>
      </Card>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <Card
          title={
            result.applied
              ? `Saved ${result.saved}; ${result.failed} not saved`
              : `${result.rows.length - result.failed} ready; ${result.failed} with problems`
          }
          actions={
            !result.applied && result.rows.length > result.failed ? (
              <Button onClick={() => void run(true)} disabled={busy}>
                Import {result.rows.length - result.failed} rows
              </Button>
            ) : null
          }
        >
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Row</th>
                {fields.map((f) => (
                  <th key={f}>{f}</th>
                ))}
                <th>Status</th>
              </tr>
            </thead>
            <tbody aria-label="Rows">
              {result.rows.map((r) => (
                <tr key={r.rowNo}>
                  <td>{r.rowNo}</td>
                  {fields.map((f) => (
                    <td key={f} className="text-sm">
                      {r.values[f] === null || r.values[f] === undefined ? '' : String(r.values[f])}
                    </td>
                  ))}
                  <td className="text-sm">
                    {r.problem ? (
                      <span className="text-danger">{r.problem}</span>
                    ) : r.saved ? (
                      <Badge tone="success">Saved</Badge>
                    ) : (
                      <Badge>Ready</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
