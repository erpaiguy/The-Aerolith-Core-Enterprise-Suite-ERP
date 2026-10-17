// The handover certificate (docs/wave8-plan.md step 8d.3): the area handed over, to whom and when, with its checklist.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { shortDate } from '../schedule/model';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { Loading, Signatures } from './PurchaseDocs';

interface Certificate {
  number: string;
  area: string;
  handedTo: string;
  checklist: { item: string; ok: boolean; note: string }[];
  status: string;
  handedOn: string | null;
  projectNumber: string;
  project: string;
  entityId: string;
}

export function HandoverPrint({ handoverId }: { handoverId: string }) {
  const q = useQuery({
    queryKey: ['handover-certificate', handoverId],
    queryFn: () => api.request<Certificate>(`/api/tenant/handovers/${handoverId}/certificate`),
  });
  if (!q.data) return <Loading q={q} />;
  const h = q.data;
  const done = h.status === 'handed_over';
  return (
    <PrintSheet
      entityId={h.entityId}
      title={`Handover certificate${done ? '' : ' — draft'}`}
      meta={
        <>
          <div className="font-semibold">{h.number}</div>
          {h.handedOn && <div>{shortDate(h.handedOn)}</div>}
        </>
      }
    >
      <Particulars
        rows={[
          ['Project', `${h.projectNumber} ${h.project}`],
          ['Area handed over', h.area],
          ['Handed to', h.handedTo],
          ['Date', h.handedOn ? shortDate(h.handedOn) : 'not yet handed over'],
        ]}
      />
      <PrintTable>
        <thead>
          <tr>
            <th>#</th>
            <th>Check</th>
            <th>Done</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {h.checklist.map((c, k) => (
            <tr key={k}>
              <td>{k + 1}</td>
              <td>{c.item}</td>
              <td>{c.ok ? 'Yes' : 'No'}</td>
              <td>{c.note}</td>
            </tr>
          ))}
        </tbody>
      </PrintTable>
      <p className="mt-3 text-sm">
        The area above is handed over in good order, with the checks listed done and no snag open in
        it. Defects that appear in the defect liability period are to be reported in writing.
      </p>
      <Signatures names={['For the contractor', `Received: ${h.handedTo}`]} />
    </PrintSheet>
  );
}
