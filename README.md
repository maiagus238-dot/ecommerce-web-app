# ecommerce-web-app

## Overview
A full-featured ecommerce web application with integrated payment gateway, security compliance, and shipping synchronization.

---

## Payment Gateway Integration

### Primary Payment Provider: Stripe

This project uses **Stripe** as the primary payment gateway provider.

**Reasons for choosing Stripe:**
- PCI DSS Level 1 compliance
- Robust webhook support with HMAC signature verification
- Comprehensive API for transaction management
- Real-time event-driven architecture for order/shipping sync

---

## Webhook Security (HMAC Signature Handling)

All incoming webhook events must be verified using HMAC signatures to prevent fraudulent requests.

### Stripe Webhook Signature Verification

```python
import stripe
import hmac
import hashlib

STRIPE_WEBHOOK_SECRET = "whsec_your_webhook_secret_here"

def verify_stripe_webhook(payload: bytes, sig_header: str) -> dict:
    """
    Verify the Stripe webhook signature using HMAC.
    
    Args:
        payload: Raw request body bytes
        sig_header: Value of the 'Stripe-Signature' header
    
    Returns:
        Verified event dict
    
    Raises:
        ValueError: If the signature is invalid or timestamp is stale
    """
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
        return event
    except stripe.error.SignatureVerificationError as e:
        raise ValueError(f"Invalid webhook signature: {e}")
```

### Manual HMAC Verification (Generic)

```python
import hmac
import hashlib

def verify_hmac_signature(
    payload: bytes,
    received_signature: str,
    secret: str,
    algorithm: str = "sha256"
) -> bool:
    """
    Generic HMAC signature verification for webhooks.
    
    Args:
        payload: Raw request body bytes
        received_signature: Signature received in the request header
        secret: Shared secret key
        algorithm: Hash algorithm (default: sha256)
    
    Returns:
        True if signature is valid, False otherwise
    """
    expected_signature = hmac.new(
        key=secret.encode("utf-8"),
        msg=payload,
        digestmod=getattr(hashlib, algorithm)
    ).hexdigest()

    return hmac.compare_digest(expected_signature, received_signature)
```

---

## Database Error Synchronization

### Error State Schema

All payment and shipping errors are persisted in the database for traceability and retry logic.

```sql
CREATE TABLE payment_transaction_errors (
    id              SERIAL PRIMARY KEY,
    transaction_id  VARCHAR(255) NOT NULL,
    provider        VARCHAR(50) NOT NULL DEFAULT 'stripe',
    error_code      VARCHAR(100),
    error_message   TEXT,
    payload         JSONB,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending_retry',
    retry_count     INT NOT NULL DEFAULT 0,
    max_retries     INT NOT NULL DEFAULT 3,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at     TIMESTAMP WITH TIME ZONE
);

CREATE TABLE shipping_sync_errors (
    id              SERIAL PRIMARY KEY,
    order_id        VARCHAR(255) NOT NULL,
    transaction_id  VARCHAR(255),
    error_code      VARCHAR(100),
    error_message   TEXT,
    shipping_status VARCHAR(100),
    payload         JSONB,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending_sync',
    retry_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Error Sync Service

```python
from datetime import datetime
from typing import Optional
import json

class PaymentErrorSyncService:
    """
    Synchronizes payment transaction errors to the database
    and coordinates with the shipping system.
    """

    def __init__(self, db_connection):
        self.db = db_connection

    def log_transaction_error(
        self,
        transaction_id: str,
        error_code: str,
        error_message: str,
        payload: dict,
        provider: str = "stripe"
    ) -> int:
        """
        Persist a payment transaction error to the database.

        Returns:
            The ID of the inserted error record.
        """
        query = """
            INSERT INTO payment_transaction_errors
                (transaction_id, provider, error_code, error_message, payload, status)
            VALUES (%s, %s, %s, %s, %s, 'pending_retry')
            RETURNING id;
        """
        cursor = self.db.cursor()
        cursor.execute(query, (
            transaction_id,
            provider,
            error_code,
            error_message,
            json.dumps(payload)
        ))
        self.db.commit()
        return cursor.fetchone()[0]

    def sync_shipping_status(
        self,
        order_id: str,
        transaction_id: str,
        shipping_status: str,
        payload: dict
    ) -> None:
        """
        Synchronize shipping status updates linked to payment events.
        Logs errors if synchronization fails.
        """
        try:
            query = """
                UPDATE orders
                SET shipping_status = %s, updated_at = NOW()
                WHERE order_id = %s AND transaction_id = %s;
            """
            cursor = self.db.cursor()
            cursor.execute(query, (shipping_status, order_id, transaction_id))
            self.db.commit()
        except Exception as e:
            self._log_shipping_sync_error(
                order_id=order_id,
                transaction_id=transaction_id,
                error_code="SHIPPING_SYNC_FAILED",
                error_message=str(e),
                shipping_status=shipping_status,
                payload=payload
            )
            raise

    def _log_shipping_sync_error(
        self,
        order_id: str,
        transaction_id: str,
        error_code: str,
        error_message: str,
        shipping_status: str,
        payload: dict
    ) -> None:
        query = """
            INSERT INTO shipping_sync_errors
                (order_id, transaction_id, error_code, error_message, shipping_status, payload)
            VALUES (%s, %s, %s, %s, %s, %s);
        """
        cursor = self.db.cursor()
        cursor.execute(query, (
            order_id,
            transaction_id,
            error_code,
            error_message,
            shipping_status,
            json.dumps(payload)
        ))
        self.db.commit()

    def retry_failed_transactions(self, max_retries: int = 3) -> list:
        """
        Fetch and retry all pending failed transactions that haven't
        exceeded the maximum retry count.

        Returns:
            List of transaction IDs that were retried.
        """
        query = """
            SELECT id, transaction_id, payload
            FROM payment_transaction_errors
            WHERE status = 'pending_retry'
              AND retry_count < %s;
        """
        cursor = self.db.cursor()
        cursor.execute(query, (max_retries,))
        rows = cursor.fetchall()

        retried = []
        for row in rows:
            error_id, transaction_id, payload = row
            try:
                # Trigger re-processing logic here
                self._increment_retry_count(error_id)
                retried.append(transaction_id)
            except Exception:
                continue

        return retried

    def _increment_retry_count(self, error_id: int) -> None:
        query = """
            UPDATE payment_transaction_errors
            SET retry_count = retry_count + 1,
                updated_at = NOW()
            WHERE id = %s;
        """
        cursor = self.db.cursor()
        cursor.execute(query, (error_id,))
        self.db.commit()
```

---

## Privacy Policy

By using this application and processing payments through our platform, users agree to the following:

- **Data Collection:** Payment data is processed securely via Stripe and is never stored on our servers in raw form.
- **PCI DSS Compliance:** All payment operations comply with PCI DSS standards.
- **Webhook Data:** Webhook payloads are verified via HMAC signatures before processing and stored only for audit/retry purposes.
- **Data Retention:** Transaction error logs are retained for a maximum of 90 days for debugging and compliance purposes.
- **Third-Party Sharing:** Payment data is shared solely with Stripe and the shipping provider for order fulfillment.
- **User Rights:** Users may request deletion of their transaction metadata by contacting [privacy@ecommerce-web-app.com](mailto:privacy@ecommerce-web-app.com).

For full details, see our [Privacy Policy](./PRIVACY_POLICY.md) and [Terms of Service](./TERMS_OF_SERVICE.md).

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret API key | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (HMAC) | ✅ |
| `DATABASE_URL` | PostgreSQL connection string | ✅ |
| `SHIPPING_API_KEY` | Shipping provider API key | ✅ |
| `SHIPPING_API_URL` | Shipping provider base URL | ✅ |

---

## Setup

```bash
# Clone the repository
git clone https://github.com/your-org/ecommerce-web-app.git
cd ecommerce-web-app

# Install dependencies
pip install -r requirements.txt

# Configure environment variables
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
python manage.py migrate

# Start the application
python manage.py runserver
```

---

## Security Checklist

- [x] Define primary payment provider (Stripe)