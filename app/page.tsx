export default function Home() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#1F3864',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ textAlign: 'center', color: 'white' }}>
        <h1 style={{ fontSize: '48px', fontWeight: '800', margin: '0 0 16px' }}>
          Longitude Inc
        </h1>
        <p style={{ fontSize: '20px', opacity: 0.7, margin: 0 }}>
          Platform coming soon
        </p>
      </div>
    </div>
  )
}
