// Finds a material (or any resource) in the rate library: a search box and the matches to choose from.
import { Button, Field, Input, Select } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Resource } from '../api/types';

/** Finds a material (or any resource) in the rate library and adds it as a line, at its current rate. */
export function ResourcePicker({ onPick }: { onPick: (r: Resource) => void }) {
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState('');
  const found = useQuery({
    queryKey: ['resource-search', q],
    queryFn: () =>
      api.request<{ items: Resource[] }>(
        `/api/tenant/resources?q=${encodeURIComponent(q)}&limit=20`,
      ),
    enabled: q.trim().length >= 2,
  });
  const items = found.data?.items ?? [];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Find in the rate library">
        <Input
          value={q}
          placeholder="Code or name"
          className="w-48"
          onChange={(e) => {
            setQ(e.target.value);
            setChosen('');
          }}
        />
      </Field>
      <div className="w-72">
        <Field label="Resource">
          <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">
              {q.trim().length < 2 ? 'Type to find…' : `${items.length} found`}
            </option>
            {items.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name} ({r.unit}){r.rate ? ` ₹${Number(r.rate)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={!chosen}
        onClick={() => {
          const r = items.find((x) => x.id === chosen);
          if (r) onPick(r);
          setChosen('');
          setQ('');
        }}
      >
        <Plus className="size-4" aria-hidden /> Add
      </Button>
    </div>
  );
}
