
app.post('/submit-booking', async (req, res) => {
  const data = req.body;

  const {
    user_name, surname, user_email, phone_prefix, contact_number,
    course, accommodation, taxi_required, arrival_date, departure_date,
    agentId, location_code, restaurant, payment_method
  } = data;

  console.log("📥 Payment Method:", payment_method);
  const fullPhone = `${phone_prefix}${contact_number}`;

  if (payment_method === 'cash') {
    db.run(\`
      INSERT INTO bookings (
        agent_id, user_name, surname, contact_number, user_email,
        restaurant, course, accommodation, taxi_required,
        arrival_date, departure_date, location_code,
        payment_method, payment_status, confirmed_by_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`, [
      agentId, user_name.trim(), surname.trim(), fullPhone.trim(), user_email.trim(),
      restaurant?.trim(), course?.trim(), accommodation?.trim(), taxi_required?.trim(),
      arrival_date.trim(), departure_date.trim(), location_code?.trim() || null,
      'cash', 'pending', 0
    ], (err) => {
      if (err) {
        console.error('❌ DB insert error for cash booking:', err.message);
        return res.send('Failed to save your booking. Please try again.');
      }

      return res.render('thank_you', {
        ...data,
        payment_method: 'cash',
        title: 'Booking Pending',
        layout: 'partials/layout'
      });
    });

  } else {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        success_url: \`\${req.protocol}://\${req.get('host')}/thank_you?session_id={CHECKOUT_SESSION_ID}\`,
        cancel_url: \`\${req.protocol}://\${req.get('host')}/booking-cancelled\`,
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'English Language Booking'
            },
            unit_amount: 5000 // €50.00 in cents — adjust if needed
          },
          quantity: 1
        }],
        metadata: {
          agentId,
          user_name: user_name.trim(),
          surname: surname.trim(),
          user_email: user_email.trim(),
          contact_number: fullPhone.trim(),
          restaurant: restaurant?.trim() || '',
          course: course?.trim() || '',
          accommodation: accommodation?.trim() || '',
          taxi_required: taxi_required?.trim() || '',
          arrival_date: arrival_date.trim(),
          departure_date: departure_date.trim(),
          location_code: location_code?.trim() || ''
        }
      });

      res.redirect(303, session.url);
    } catch (err) {
      console.error("❌ Stripe session error:", err.message);
      res.send("Failed to redirect to Stripe.");
    }
  }
});
