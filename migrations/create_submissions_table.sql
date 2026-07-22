`create table if not exists public.submissions (
  id bigserial primary key,
  category text not null,
  name text not null,
  department text null,
  level text null,
  "imageName" text null,
  reason text null,
  "receivedAt" timestamptz null default now(),
  votes integer null default 0
);
`