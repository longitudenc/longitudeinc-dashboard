'use client'

import { useEffect, useState } from 'react'
import { AMS, AM_ORDER, SALON_NAMES, salonDisplay } from '@/lib/config'

// ── Helpers ───────────────────────────────────────────────────
function n(v: any) { return parseFloat(v) || 0 }
function sgn(v: number) { return v >= 0 ? '+' : '' }
function money(v: any) { return '$' + n(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) }
function pct(v: any, decimals = 1) { return n(v).toFixed(decimals) + '%' }

// Tier colors based on metric
function tierCC(v: number) { return v >= 520 ? '#2d7a1a' : v >= 420 ? '#c8a800' : v >= 320 ? '#d06010' : '#b83232' }
function tierNR(v: number) { return v >= 26 ? '#2d7a1a' : v >= 24 ? '#c8a800' : v >= 21 ? '#d06010' : '#b83232' }
function tierRR(v: number) { return v >= 77 ? '#2d7a1a' : v >= 73.9 ? '#c8a800' : v >= 70.9 ? '#d06010' : '#b83232' }
function tierHC(v: number) { return v <= 12 ? '#2d7a1a' : v <= 14 ? '#c8a800' : v <= 17 ? '#d06010' : '#b83232' }
function tierMBC(v: number) { return v <= 2.0 ? '#2d7a1a' : v <= 2.5 ? '#c8a800' : v <= 3.0 ? '#d06010' : '#b83232' }
function tierWaits(v: number) { return v <= 15 ? '#2d7a1a' : v <= 19 ? '#c8a800' : v <= 22.9 ? '#d06010' : '#b83232' }
function tierPayroll(v: number, cc: number) {
  // Simplified — use CC 400-449 range as default
  const exc = cc >= 400 ? 38 : cc >= 300 ? 44 : 48
  const grw = exc + 1
  return v <= exc ? '#2d7a1a' : v <= grw ? '#c8a800' : '#b83232'
}
function tierGrowth(v: number) { return v >= 5 ? '#2d7a1a' : v >= 3 ? '#c8a800' : v >= 1 ? '#d06010' : '#b83232' }

export default function DashboardPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentAM, setCurrentAM] = useState('cassi')
  const [globalMode, setGlobalMode] = useState<'week' | 'ytd'>('week')
  const [selectedWeek, setSelectedWeek] = useState('')
  const [activeTab, setActiveTab] = useState('scorecard')

  useEffect(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setData(d)
          const weeks = [...new Set(d.salonRows.map((r: any) => r.weekEnding))].sort() as string[]
          if (weeks.length) setSelectedWeek(weeks[weeks.length - 1])
        } else setError(d.error || 'Failed to load')
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} />
  if (!data) return null

  const am = AMS[currentAM]
  const amSalons = am?.salons || []
  const allWeeks = [...new Set(data.salonRows.map((r: any) => r.weekEnding))].sort() as string[]

  // Get rows for current week and AM's salons
  const weekRows = data.salonRows.filter((r: any) =>
    r.weekEnding === selectedWeek && amSalons.includes(r.salonNum)
  )

  // YTD: all weeks for this AM
  const ytdRows = data.salonRows.filter((r: any) => amSalons.includes(r.salonNum))

  const displayRows = globalMode === 'ytd' ? ytdRows : weekRows

  // Compute averages
  const avg = (rows: any[], field: string) =>
    rows.length ? rows.reduce((s: number, r: any) => s + n(r[field]), 0) / rows.length : 0
  const sum = (rows: any[], field: string) =>
    rows.reduce((s: number, r: any) => s + n(r[field]), 0)

  // Group YTD by salon for display
  const salonAvgs = amSalons.map(snum => {
    const rows = ytdRows.filter((r: any) => r.salonNum === snum)
    if (!rows.length) return null
    return {
      salonNum: snum,
      salesThis: avg(rows, 'salesThis'),
      salesGrowth: avg(rows, 'salesGrowth'),
      ccThis: avg(rows, 'ccThis'),
      ccGrowth: avg(rows, 'ccGrowth'),
      nr: avg(rows, 'nr'),
      rr: avg(rows, 'rr'),
      product: avg(rows, 'product'),
      payroll: avg(rows, 'payroll'),
      waits: avg(rows, 'waits'),
      ssWaits: avg(rows, 'ssWaits'),
      hcTime: avg(rows, 'hcTime'),
      cph: avg(rows, 'cph'),
      mbc: avg(rows, 'mbc'),
    }
  }).filter(Boolean)

  const tableRows = globalMode === 'ytd' ? salonAvgs : weekRows

  const summaryCC = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'ccThis')
  const summaryNR = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'nr')
  const summaryRR = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'rr')
  const summaryHC = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'hcTime')
  const summaryMBC = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'mbc')
  const summaryPay = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'payroll')
  const summaryGrowth = avg(globalMode === 'ytd' ? salonAvgs : weekRows, 'ccGrowth')

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f9f8f6', fontFamily: 'system-ui, sans-serif' }}>
      {/* Sidebar */}
      <div style={{ width: '210px', background: '#1F3864', color: 'white', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '14px 16px', fontSize: '12px', fontWeight: '800', letterSpacing: '.08em', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          LONGITUDE INC — AM DASHBOARD
        </div>
        <div style={{ padding: '10px 12px 4px', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em', color: 'rgba(255,255,255,0.5)' }}>
          Area Managers
        </div>
        {AM_ORDER.map(id => {
          const a = AMS[id]
          const active = currentAM === id
          return (
            <button key={id} onClick={() => { setCurrentAM(id); setActiveTab('scorecard') }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', background: active ? 'rgba(255,255,255,0.12)' : 'transparent', border: 'none', color: 'white', cursor: 'pointer', textAlign: 'left', fontSize: '13px', fontWeight: active ? '700' : '400', borderLeft: active ? `3px solid ${a.color}` : '3px solid transparent' }}>
              <span style={{ width: '28px', height: '28px', borderRadius: '50%', background: a.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', flexShrink: 0 }}>{a.init}</span>
              {a.name.split(' ')[0]} {a.name.split(' ')[1]?.[0]}.
            </button>
          )
        })}
        <div style={{ padding: '10px 12px 4px', marginTop: '8px', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.08em', color: 'rgba(255,255,255,0.5)' }}>
          Views
        </div>
        <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '13px', textAlign: 'left' }}>
          CO &nbsp; Company Overview
        </button>
        <button style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '13px', textAlign: 'left' }}>
          ⚙ Admin / Upload
        </button>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 24px', background: '#1F3864', color: 'white' }}>
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.15)', borderRadius: '20px', padding: '2px', marginLeft: 'auto' }}>
            {(['week', 'ytd'] as const).map(mode => (
              <button key={mode} onClick={() => setGlobalMode(mode)}
                style={{ padding: '5px 14px', borderRadius: '18px', border: 'none', background: globalMode === mode ? 'white' : 'transparent', color: globalMode === mode ? '#1F3864' : 'rgba(255,255,255,0.8)', fontWeight: '700', fontSize: '12px', cursor: 'pointer' }}>
                {mode === 'week' ? 'This Week' : 'YTD'}
              </button>
            ))}
          </div>
          <select value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)}
            style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: '8px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer' }}>
            {allWeeks.map((w: string) => (
              <option key={w} value={w} style={{ background: '#1F3864' }}>Week Ending {w}</option>
            ))}
          </select>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.8)' }}>longitudenc@gmail.com</div>
        </div>

        {/* Page header */}
        <div style={{ padding: '16px 24px 8px', background: 'white', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ margin: '0 0 2px', fontSize: '20px', fontWeight: '700', color: '#1F3864' }}>{am?.name}</h2>
          <div style={{ color: '#6b7280', fontSize: '13px' }}>Area Manager · Week Ending {selectedWeek}</div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', padding: '10px 24px 0', background: 'white', borderBottom: '1px solid #e5e7eb' }}>
          {[
            { key: 'scorecard', label: 'Scorecard' },
            { key: 'salon', label: 'Salon Performance' },
            { key: 'individual', label: 'Individual Performance' },
            { key: 'trends', label: 'Trends' },
            { key: 'bonus', label: 'Bonus 🔥' },
          ].map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              style={{ padding: '7px 14px', border: 'none', background: activeTab === t.key ? '#1F3864' : 'transparent', color: activeTab === t.key ? 'white' : '#6b7280', borderRadius: '6px 6px 0 0', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {activeTab === 'scorecard' && (
            <div>
              {/* Summary stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px', marginBottom: '20px' }}>
                {[
                  { label: 'Avg CC', value: Math.round(summaryCC), color: tierCC(summaryCC) },
                  { label: 'CC Growth', value: sgn(summaryGrowth) + summaryGrowth.toFixed(1) + '%', color: tierGrowth(summaryGrowth) },
                  { label: 'New Return %', value: summaryNR.toFixed(1) + '%', color: tierNR(summaryNR) },
                  { label: 'Repeat Return %', value: summaryRR.toFixed(1) + '%', color: tierRR(summaryRR) },
                  { label: 'Avg HC Time', value: summaryHC.toFixed(1), color: tierHC(summaryHC) },
                  { label: 'Avg MBC', value: summaryMBC.toFixed(1), color: tierMBC(summaryMBC) },
                  { label: 'Payroll %', value: summaryPay.toFixed(1) + '%', color: tierPayroll(summaryPay, summaryCC) },
                ].map(m => (
                  <div key={m.label} style={{ background: 'white', borderRadius: '10px', padding: '14px', boxShadow: '0 1px 3px rgba(0,0,0,.06)', borderTop: `3px solid ${m.color}` }}>
                    <div style={{ fontSize: '22px', fontWeight: '700', color: m.color }}>{m.value}</div>
                    <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '.05em' }}>{m.label}</div>
                  </div>
                ))}
              </div>

              {/* Salon table */}
              <div style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.06)', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', fontWeight: '700', color: '#1F3864', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Salon Breakdown {globalMode === 'ytd' ? '— YTD Avg' : `— ${selectedWeek}`}</span>
                  <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '400' }}>{tableRows.length} salons</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ background: '#f5f4f1' }}>
                        {['Salon', 'Avg CC', 'CC Growth', 'NR%', 'RR%', 'HC Time', 'CPH', 'MBC', 'S/S Waits', 'Waits', 'Payroll'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Salon' ? 'left' : 'center', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((row: any, i: number) => {
                        const cc = n(row.ccThis)
                        return (
                          <tr key={i} style={{ borderTop: '1px solid #f5f5f3' }}>
                            <td style={{ padding: '8px 10px', fontWeight: '600', color: '#1F3864', whiteSpace: 'nowrap' }}>{salonDisplay(row.salonNum)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierCC(cc), fontWeight: '600' }}>{Math.round(cc)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierGrowth(n(row.ccGrowth)) }}>{sgn(n(row.ccGrowth))}{n(row.ccGrowth).toFixed(1)}%</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierNR(n(row.nr)) }}>{n(row.nr).toFixed(1)}%</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierRR(n(row.rr)) }}>{n(row.rr).toFixed(1)}%</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierHC(n(row.hcTime)) }}>{n(row.hcTime).toFixed(1)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.cph).toFixed(1)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierMBC(n(row.mbc)) }}>{n(row.mbc).toFixed(1)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierWaits(n(row.ssWaits)) }}>{n(row.ssWaits).toFixed(1)}%</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierWaits(n(row.waits)) }}>{n(row.waits).toFixed(1)}%</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: tierPayroll(n(row.payroll), cc) }}>{n(row.payroll).toFixed(1)}%</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'salon' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
              {tableRows.map((row: any, i: number) => (
                <div key={i} style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.06)', padding: '16px' }}>
                  <div style={{ fontWeight: '700', color: '#1F3864', marginBottom: '10px', fontSize: '14px' }}>{salonDisplay(row.salonNum)}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
                    <Stat label="Sales" value={money(row.salesThis)} />
                    <Stat label="Growth" value={sgn(n(row.salesGrowth)) + n(row.salesGrowth).toFixed(1) + '%'} color={n(row.salesGrowth) >= 0 ? '#2d7a1a' : '#b83232'} />
                    <Stat label="Avg CC" value={Math.round(n(row.ccThis)).toString()} color={tierCC(n(row.ccThis))} />
                    <Stat label="CC Growth" value={sgn(n(row.ccGrowth)) + n(row.ccGrowth).toFixed(1) + '%'} color={tierGrowth(n(row.ccGrowth))} />
                    <Stat label="NR%" value={n(row.nr).toFixed(1) + '%'} color={tierNR(n(row.nr))} />
                    <Stat label="RR%" value={n(row.rr).toFixed(1) + '%'} color={tierRR(n(row.rr))} />
                    <Stat label="Payroll" value={n(row.payroll).toFixed(1) + '%'} color={tierPayroll(n(row.payroll), n(row.ccThis))} />
                    <Stat label="CPH" value={n(row.cph).toFixed(1)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'individual' && (
            <IndividualTab data={data} selectedWeek={selectedWeek} amSalons={amSalons} globalMode={globalMode} />
          )}

          {activeTab === 'trends' && (
            <div style={{ background: 'white', borderRadius: '10px', padding: '2rem', textAlign: 'center', color: '#6b7280', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
              📈 Trends coming in next update
            </div>
          )}

          {activeTab === 'bonus' && (
            <div style={{ background: 'white', borderRadius: '10px', padding: '2rem', textAlign: 'center', color: '#6b7280', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
              💰 Bonus module coming in next update
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <span style={{ color: '#9ca3af' }}>{label}: </span>
      <strong style={{ color: color || '#1f2937' }}>{value}</strong>
    </div>
  )
}

function IndividualTab({ data, selectedWeek, amSalons, globalMode }: any) {
  const empRows = data.empRows.filter((r: any) =>
    (globalMode === 'week' ? r.weekEnding === selectedWeek : true) && amSalons.includes(r.salonNum)
  )

  if (!empRows.length) return (
    <div style={{ background: 'white', borderRadius: '10px', padding: '2rem', textAlign: 'center', color: '#6b7280' }}>
      No individual data for this period
    </div>
  )

  return (
    <div style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,.06)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', fontWeight: '700', color: '#1F3864', fontSize: '13px' }}>
        Individual Performance
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: '#f5f4f1' }}>
              {['Employee', 'Salon', 'Hrs', 'Guests', 'CPH', 'HC Time', 'MBC', 'NR%', 'RR%', 'Product%'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Employee' || h === 'Salon' ? 'left' : 'center', fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empRows.map((row: any, i: number) => (
              <tr key={i} style={{ borderTop: '1px solid #f5f5f3' }}>
                <td style={{ padding: '8px 10px', fontWeight: '600' }}>{row.empName}</td>
                <td style={{ padding: '8px 10px', color: '#6b7280' }}>{salonDisplay(row.salonNum)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.floorHours).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.custCount)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.cph).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.hcTime).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center', color: tierMBC(n(row.mbc)) }}>{n(row.mbc).toFixed(1)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'center', color: tierNR(n(row.nr)) }}>{n(row.nr).toFixed(1)}%</td>
                <td style={{ padding: '8px 10px', textAlign: 'center', color: tierRR(n(row.rr)) }}>{n(row.rr).toFixed(1)}%</td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>{n(row.product).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{ minHeight: '100vh', background: '#1F3864', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'system-ui' }}>
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
      <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', background: '#1F3864', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', marginTop: '8px' }}>Retry</button>
    </div>
  )
}
