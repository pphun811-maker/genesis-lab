import { Navigate, Route, Routes } from 'react-router-dom';
import { CompareView } from './views/CompareView';
import { CreateView } from './views/CreateView';
import { HomeView } from './views/HomeView';
import { ObservatoryView } from './views/ObservatoryView';

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/create" element={<CreateView />} />
        <Route path="/exp/:id" element={<ObservatoryView />} />
        <Route path="/compare" element={<CompareView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
