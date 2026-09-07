import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* C40：全局兜底——面板级 boundary 之外的最后防线（如 App 壳本身异常） */}
    <ErrorBoundary name="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
