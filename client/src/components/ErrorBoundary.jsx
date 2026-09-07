import React from 'react';

// C40：面板级错误边界。
// 缺陷背景：任何面板渲染抛错会沿 React 树向上卸载整棵树 → 全应用白屏，只能 F5。
// 语义：
//  - key={tab} 由父级控制：切换面板即重挂载，崩过的面板切走再切回自动重置；
//  - 「重试」仅重置本 boundary 的错误态（重新渲染同一面板）；
//  - 「刷新整页」兜底（state 彻底重置）；
//  - 渲染期错误摘要上屏，完整堆栈走 console.error（不向用户暴露原始堆栈）。
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary:' + (this.props.name || 'unknown') + ']', error, info && info.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      const name = this.props.name || '当前面板';
      const msg = String(this.state.error && this.state.error.message || this.state.error).slice(0, 200);
      return (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-6 space-y-3">
          <div className="text-sm font-semibold text-rose-300">⚠️ {name} 渲染出错（其余面板不受影响）</div>
          <div className="text-xs text-slate-300 font-mono break-all">{msg}</div>
          <div className="flex gap-2">
            <button onClick={this.retry} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs">重试</button>
            <button onClick={() => window.location.reload()} className="px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 text-xs">刷新整页</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
