"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppShell, Badge, Button, EmptyState, Page, PageHeader, Skeleton, Table, Td, Th } from "@/components/ui";
import { ApiError, api, type Role } from "@/lib/api";

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .roles()
      .then((r) => {
        setRoles(r);
        setError("");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load roles."));

  useEffect(() => {
    void load();
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Roles"
        description="Each role is a rubric: the skills an interview covers and what a strong answer contains."
        actions={
          <Link href="/roles/new">
            <Button variant="primary">New role</Button>
          </Link>
        }
      />
      <Page>
        {error && (
          <div role="alert" className="mb-4 flex items-center justify-between rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad-fg">
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}
        {!roles && !error && (
          <Table>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Skills</Th>
              </tr>
            </thead>
            <tbody>
              {[0, 1].map((i) => (
                <tr key={i}>
                  <Td>
                    <Skeleton className="h-3.5 w-48" />
                  </Td>
                  <Td>
                    <Skeleton className="h-[22px] w-72" />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {roles && roles.length === 0 && (
          <EmptyState
            title="No roles yet"
            description="A role is the rubric an interview runs on. Paste a job description and the skills come out drafted."
            action={
              <Link href="/roles/new">
                <Button variant="primary">New role</Button>
              </Link>
            }
          />
        )}
        {roles && roles.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Skills</Th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.key} className="hover:bg-surface-2">
                  <Td>
                    <Link href={`/roles/${r.key}`} className="font-medium text-fg hover:underline">
                      {r.title}
                    </Link>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12px] text-fg-3">{r.key}</span>
                      {r.builtin && <span className="text-[12px] text-fg-4">built in</span>}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.skills.map((s) => (
                        <Badge key={s.key}>{s.name}</Badge>
                      ))}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-4 text-[12px] text-fg-3">
          Built-in roles are read-only. Roles you add are written as YAML alongside the database, so
          they survive a restart and can be edited by hand too.
        </p>
      </Page>
    </AppShell>
  );
}
