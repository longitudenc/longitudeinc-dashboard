'use client'

import { useEffect, useState } from 'react'
import { AMS, AM_ORDER, SALON_NAMES, salonDisplay, amOf } from '@/lib/config'

// ── Types ─────────────────────────────────────────────────────
interface DashboardData {
  salonRows: any[]
  empRows: any[]
  bonusRows: any[]
  salonSummaryRows: any[]
  payrollRows: any[]
  managerRows: any[]
  waiverRows: any[]
  homeRows: any[]
  trackerRows: any[]
}

// ── Helpers ───────────────────────────────────────────────────
function n(v: any) { return parseFloat(v) || 0 }
function pct(v: any) { return (n(v) * 100).toFixed(1) + '%' }
function money(v: any) { return '$' + n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function sgn(v: number) { return v >= 0 ? '+' : '' }

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentAM, setCurrentAM] = useState('cassi')
  const [globalMode, setGlobalMode] = useState<'week' | 'ytd'>('week')
  const [selectedWeek, setSelectedWeek] = useState<string>('')
  const [activeTab, setActiveTab] = useState('scorecard')

  useEffect(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setData(d)
          // Set most recent week
          const weeks = [...new Set(d.salonRows.map((r: any) => r.weekEnding))].sort() as string[]
          if (weeks.length) setSelectedWeek(weeks[weeks.length - 1])
        } else {
          setError(d.error || 'Failed to load data')
        }
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!data) return null

  const am = AMS[currentAM]
  const amSalons = am?.salons || []

  // Filter salon rows for this AM and week
  const weekRows = data.salonRows.filter((r: any) =>
    r.weekEnding === selectedWeek && amSalons.includes(r.salonNum)
  )

  const allWeeks = [...new Set(data.salonRows.map((r: any) => r.weekEnding))].sort() as string[]

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f9f8f6', fontFamily: 'system-ui, sans-serif' }}>
      {/* Sidebar */}
      <Sidebar
        currentAM={currentAM}
        setCurrentAM={setCurrentAM}
        setActiveTab={setActiveTab}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <TopBar
          globalMode={globalMode}
          setGlobalMode={setGlobalMode}
          selectedWeek={selectedWeek}
          setSelectedWeek={setSelectedWeek}
          allWeeks={allWeeks}
        />

        {/* Page header */}
        <div style={{ padding: '1.5rem 2rem .5rem', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ margin: 0, fontSize: '22px', fontWeight: '700', color: '#1F3864' }}>
            {am?.name}
          </h2>
          <div style={{ color: '#6b7280', fontSize: '13px', marginTop: '2px' }}>
            Area Manager · Week Ending {selectedWeek || '—'}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '2px', padding: '12px 2rem 0', background: 'white', borderBottom: '1px solid #e5e7eb' }}>
          {['Scorecard', 'Salon Performance', 'Individual Performance', 'Bonus'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab.toLowerCase().replace(' ', '-'))}
              style={{
                padding: '8px 16px',
                border: 'none',
                background: activeTab === tab.toLowerCase().replace(' ', '-') ? '#1F3864' : 'transparent',
                color: activeTab === tab.toLowerCase().replace(' ', '-') ? 'white' : '#6b7280',
                borderRadius: '6px 6px 0 0',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: '600',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem 2rem' }}>
          {activeTab === 'scorecard' && (
            <ScorecardTab weekRows={weekRows} amSalons={amSalons} data={data} selectedWeek={selectedWeek} globalMode={globalMode} currentAM={currentAM} />
          )}
          {activeTab === 'salon-performance' && (
            <SalonPerformanceTab weekRows={weekRows} />
          )}
          {activeTab === 'individual-performance' && (
            <IndividualPerformanceTab data={data} selectedWeek={selectedWeek} amSalons={amSalons} />
          )}
          {activeTab === 'bonus' && (
            <div style={{ color: '#6b7280', padding: '2rem', textAlign: 'center' }}>
              Bonus module coming in next session
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────
function Sidebar({ currentAM, setCurrentAM, setActiveTab }: any) {
  return (
    <div style={{
      width: '200px',
      background: '#1F3864',
      color: 'white',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{ padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', fontSize: '13px', fontWeight: '800', letterSpacing: '.08em' }}>
        LONGITUDE INC
      </div>
      <div style={{ padding: '12px 8px', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em', color: 'rgba(255,255,255,0.5)', paddingLeft: '12px' }}>
        Area Managers
      </div>
      {AM_ORDER.map(id => {
        const am = AMS[id]
        const active = currentAM === id
        return (
          <button
            key={id}
            onClick={() => { setCurrentAM(id); setActiveTab('scorecard') }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 12px',
              background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '13px',
              fontWeight: active ? '700' : '400',
              borderLeft: active ? `3px solid ${am.color}` : '3px solid transparent',
            }}
          >
            <span style={{
              width: '28px', height: '28px', borderRadius: '50%',
              background: am.color, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: '11px', fontWeight: '700', flexShrink: 0,
            }}>
              {am.init}
            </span>
            <span>{am.name.split(' ')[0]} {am.name.split(' ')[1]?.[0]}.</span>
          </button>
        )
      })}
      <div style={{ padding: '12px 8px', marginTop: '8px', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em', color: 'rgba(255,255,255,0.5)', paddingLeft: '12px' }}>
        Views
      </div>
      <button
        onClick={() => window.location.href = '/company'}
        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '13px', textAlign: 'left' }}
      >
        CO &nbsp; Company Overview
      </button>
    </div>
  )
}

// ── Top Bar ───────────────────────────────────────────────────
function TopBar({ globalMode, setGlobalMode, selectedWeek, setSelectedWeek, allWeeks }: any) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '10px 2rem',
      background: '#1F3864',
      color: 'white',
    }}>
      <span style={{ fontWeight: '700', fontSize: '14px', letterSpacing: '.05em', marginRight: 'auto' }}>
        LONGITUDE INC — AM DASHBOARD
      </span>

      {/* This Week / YTD toggle */}
      <div style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', borderRadius: '20px', padding: '2px' }}>
        {(['week', 'ytd'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => setGlobalMode(mode)}
            style={{
              padding: '5px 14px', borderRadius: '18px', border: 'none',
              background: globalMode === mode ? 'white' : 'transparent',
              color: globalMode === mode ? '#1F3864' : 'rgba(255,255,255,0.8)',
              fontWeight: '700', fontSize: '12px', cursor: 'pointer',
            }}
          >
            {mode === 'week' ? 'This Week' : 'YTD'}
          </button>
        ))}
      </div>

      {/* Week selector */}
      <select
        value={selectedWeek}
        onChange={e => setSelectedWeek(e.target.value)}
        style={{
          background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
          color: 'white', borderRadius: '8px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer',
        }}
      >
        {allWeeks.map((w: string) => (
          <option key={w} value={w} style={{ background: '#1F3864' }}>
            Week Ending {w}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Scorecard Tab ─────────────────────────────────────────────
function ScorecardTab({ weekRows, amSalons, data, selectedWeek, globalMode, currentAM }: any) {
  const avg = (field: string) => {
    if (!weekRows.length) return 0
    return weekRows.reduce((s: number, r: any) => s + n(r[field]), 0) / weekRows.length
  }

  const sum = (field: string) => weekRows.reduce((s: number, r: any) => s + n(r[field]), 0)

  const metrics = [
    { label: 'Avg CC', value: Math.round(avg('ccThis')), format: (v: any) => v.toString() },
    { label: 'CC Growth', value: avg('ccGrowth') * 100, format: (v: any) => sgn(v) + v.toFixed(1) + '%' },
    { label: 'New Return %', value: avg('nr') * 100, format: (v: any) => v.toFixed(1) + '%' },
    { label: 'Repeat Return %', value: avg('rr') * 100, format: (v: any) => v.toFixed(1) + '%' },
    { label: 'Avg HC Time', value: avg('hcTime'), format: (v: any) => v.toFixed(1) },
    { label: 'Avg MBC', value: avg('mbc'), format: (v: any) => v.toFixed(1) },
    { label: 'Payroll %', value: avg('payroll') * 100, format: (v: any) => v.toFixed(1) + '%' },
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {metrics.map(m => (
          <div key={m.label} style={{ background: 'white', borderRadius: '10px', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: '#1F3864' }}>{m.format(m.value)}</div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '.05em' }}>{m.label}</div>
          </div>
        ))}
      </div>

      {/* Salon breakdown */}
      <div style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.08)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f0', fontWeight: '700', color: '#1F3864', fontSize: '13px' }}>
          Salon Breakdown — {selectedWeek}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: '#f8f8f6' }}>
                {['Salon', 'Avg CC', 'CC Growth', 'NR%', 'RR%', 'HC Time', 'CPH', 'MBC', 'S/S Waits', 'Waits', 'Payroll'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Salon' ? 'left' : 'center', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekRows.map((row: any, i: number) => (
                <tr key={i} style={{ borderTop: '1px solid #f5f5f3' }}>
                  <td style={{ padding: '8px 10px', fontWeight: '600', color: '#1F3864' }}>{salonDisplay(row.salonNum)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{Math.round(n(row.ccThis))}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center', color: n(row.ccGrowth) >= 0 ? '#2d7a1a' : '#b83232' }}>{sgn(n(row.ccGrowth) * 100)}{(n(row.ccGrowth) * 100).toFixed(1)}%</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.nr) * 100).toFixed(1)}%</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.rr) * 100).toFixed(1)}%</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.hcTime).toFixed(1)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.cph).toFixed(1)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.mbc).toFixed(1)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.ssWaits) * 100).toFixed(1)}%</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.waits) * 100).toFixed(1)}%</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center', color: n(row.payroll) > 0.42 ? '#b83232' : '#2d7a1a' }}>{(n(row.payroll) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Salon Performance Tab ─────────────────────────────────────
function SalonPerformanceTab({ weekRows }: any) {
  return (
    <div style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.08)', padding: '16px' }}>
      <div style={{ fontWeight: '700', color: '#1F3864', marginBottom: '12px' }}>Salon Performance</div>
      {weekRows.length === 0 ? (
        <div style={{ color: '#6b7280', padding: '2rem', textAlign: 'center' }}>No data for selected week</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
          {weekRows.map((row: any, i: number) => (
            <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px' }}>
              <div style={{ fontWeight: '700', color: '#1F3864', marginBottom: '8px' }}>{salonDisplay(row.salonNum)}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
                <div><span style={{ color: '#6b7280' }}>Sales: </span><strong>{money(row.salesThis)}</strong></div>
                <div><span style={{ color: '#6b7280' }}>Growth: </span><strong style={{ color: n(row.salesGrowth) >= 0 ? '#2d7a1a' : '#b83232' }}>{sgn(n(row.salesGrowth) * 100)}{(n(row.salesGrowth) * 100).toFixed(1)}%</strong></div>
                <div><span style={{ color: '#6b7280' }}>Avg CC: </span><strong>{Math.round(n(row.ccThis))}</strong></div>
                <div><span style={{ color: '#6b7280' }}>NR%: </span><strong>{(n(row.nr) * 100).toFixed(1)}%</strong></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Individual Performance Tab ────────────────────────────────
function IndividualPerformanceTab({ data, selectedWeek, amSalons }: any) {
  const empRows = data.empRows.filter((r: any) =>
    r.weekEnding === selectedWeek && amSalons.includes(r.salonNum)
  )

  return (
    <div style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.08)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #f0f0f0', fontWeight: '700', color: '#1F3864', fontSize: '13px' }}>
        Individual Performance — {selectedWeek}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: '#f8f8f6' }}>
              {['Employee', 'Salon', 'Hrs', 'CPH', 'HC Time', 'MBC', 'NR%', 'RR%', 'Product%'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Employee' || h === 'Salon' ? 'left' : 'center', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empRows.map((row: any, i: number) => (
              <tr key={i} style={{ borderTop: '1px solid #f5f5f3' }}>
                <td style={{ padding: '8px 10px', fontWeight: '600' }}>{row.empName}</td>
                <td style={{ padding: '8px 10px', color: '#6b7280' }}>{salonDisplay(row.salonNum)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.floorHours).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.cph).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.hcTime).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.mbc).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.nr) * 100).toFixed(1)}%</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.rr) * 100).toFixed(1)}%</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{(n(row.product) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Loading / Error screens ───────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{ minHeight: '100vh', background: 'rgba(26,26,46,.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'system-ui' }}>
      <div style={{ width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.2)', borderTop: '3px solid white', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '16px' }} />
      <div style={{ fontSize: '16px', fontWeight: '600' }}>Loading AM Dashboard...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '32px' }}>⚠️</div>
      <div style={{ fontWeight: '700', color: '#1F3864' }}>Failed to load dashboard</div>
      <div style={{ color: '#6b7280', fontSize: '13px' }}>{message}</div>
      <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', background: '#1F3864', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', marginTop: '8px' }}>
        Retry
      </button>
    </div>
  )
}
