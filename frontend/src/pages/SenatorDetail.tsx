import { useParams } from "react-router-dom";

export default function SenatorDetail() {
  const { id } = useParams();
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold text-white">Politician Detail</h1>
      <p className="text-sm text-muted">Selected politician id: {id}</p>
    </div>
  );
}
