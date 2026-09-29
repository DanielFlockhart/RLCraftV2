import { DatasetInspector } from "../../../components/dataset-inspector";

export default async function DatasetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DatasetInspector key={id} id={id} />;
}
