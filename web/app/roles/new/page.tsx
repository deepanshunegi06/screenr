"use client";

import { AppShell, Page, PageHeader } from "@/components/ui";
import { RoleEditor } from "@/components/RoleEditor";

export default function NewRolePage() {
  return (
    <AppShell>
      <PageHeader
        title="New role"
        description="A role is the rubric an interview runs on: the skills it covers, and what a strong answer contains for each."
        crumbs={[{ href: "/roles", label: "Roles" }, { label: "New" }]}
      />
      <Page>
        <RoleEditor />
      </Page>
    </AppShell>
  );
}
