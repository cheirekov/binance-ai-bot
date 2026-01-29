import { useEffect, useMemo, useState } from 'react';

import { BottomNav, NavTabId } from './components/layout/BottomNav';
import { TopBar } from './components/layout/TopBar';
import { ToastProvider } from './components/ui/Toast';
import { useBotState } from './hooks/useBotState';
import { HomePage } from './pages/Home';
import { OrdersPage } from './pages/Orders';
import { PortfolioPage } from './pages/Portfolio';
import { StatusPage } from './pages/Status';
import { StrategyPage } from './pages/Strategy';
import { readStorage, writeStorage } from './utils/storage';

const TABS: Array<{ id: NavTabId; label: string; icon: string; disabled?: boolean }> = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'portfolio', label: 'Portfolio', icon: '◧' },
  { id: 'orders', label: 'Orders', icon: '≡' },
  { id: 'strategy', label: 'Strategy', icon: '✶' },
  { id: 'status', label: 'Status', icon: '●' },
];

const readInitialTab = (): NavTabId => {
  const raw = (readStorage('activeTab') ?? '').toLowerCase();
  if (raw === 'home' || raw === 'portfolio' || raw === 'orders' || raw === 'strategy' || raw === 'status') return raw;
  return 'home';
};

const AppShell = () => {
  const bot = useBotState();
  const [tab, setTab] = useState<NavTabId>(readInitialTab);

  useEffect(() => {
    writeStorage('activeTab', tab);
  }, [tab]);

  const apiHealth = useMemo(() => {
    if (bot.apiHealth.status === 'error') {
      return { status: 'error' as const, title: bot.apiHealth.lastErrorMessage };
    }
    if (bot.apiHealth.status === 'ok') return { status: 'ok' as const, title: undefined };
    return { status: 'idle' as const, title: undefined };
  }, [bot.apiHealth]);

  const tabs = useMemo(() => {
    return TABS;
  }, []);

  useEffect(() => {
    const current = tabs.find((t) => t.id === tab);
    if (current?.disabled) setTab('home');
  }, [tab, tabs]);

  return (
    <div className="app-shell">
      <TopBar
        appName="Binance AI Bot"
        data={bot.data}
        loading={bot.loading}
        selectedSymbol={bot.selectedSymbol}
        availableSymbols={bot.availableSymbols}
        onSelectSymbol={bot.setSelectedSymbol}
        lastSuccessAt={bot.lastSuccessAt}
        apiHealth={apiHealth}
        nav={{ active: tab, tabs: tabs.map(({ id, label, disabled }) => ({ id, label, disabled })), onChange: setTab }}
      />

      <main className="app-main">
        {tab === 'home' ? (
          <HomePage
            data={bot.data}
            loading={bot.loading}
            error={bot.error}
            lastSuccessAt={bot.lastSuccessAt}
            onRefreshNow={bot.refreshNow}
            onSync={bot.sync}
            onAutoPick={bot.autoPickBest}
          />
        ) : null}
        {tab === 'portfolio' ? <PortfolioPage data={bot.data} loading={bot.loading} /> : null}
        {tab === 'orders' ? <OrdersPage data={bot.data} selectedSymbol={bot.selectedSymbol} /> : null}
        {tab === 'strategy' ? <StrategyPage data={bot.data} selectedSymbol={bot.selectedSymbol} onSync={bot.sync} /> : null}
        {tab === 'status' ? <StatusPage data={bot.data} selectedSymbol={bot.selectedSymbol} onSync={bot.sync} /> : null}
      </main>

      <div className="mobile-only">
        <BottomNav active={tab} tabs={tabs} onChange={setTab} />
      </div>
    </div>
  );
};

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
