import { AgentDetails } from "../../../../components/agent-details";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ runId: string; username: string }>;
}) {
  const { runId, username } = await params;
  return (
    <AgentDetails
      key={`${runId}/${username}`}
      runId={runId}
      username={username}
    />
  );
}
