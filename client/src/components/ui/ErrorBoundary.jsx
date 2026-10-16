import React from 'react'
import { ErrorState } from './UIStates.jsx'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
    if (this.props.onReset) {
      this.props.onReset()
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem' }}>
          <ErrorState
            message={`Something went wrong loading this section: ${this.state.error?.message || 'Unexpected error'}`}
            onRetry={this.handleRetry}
          />
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
