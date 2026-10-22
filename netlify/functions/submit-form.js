export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { recaptchaToken, formData } = JSON.parse(event.body);
    console.log('Received form data:', formData);
    
    // Verify reCAPTCHA Enterprise
    const recaptchaResponse = await fetch(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/assessments?key=${process.env.GOOGLE_CLOUD_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            token: recaptchaToken,
            siteKey: '6Le6W1osAAAAAEySdjeFfrJffcwvyfL2ph1Dsxyf',
            expectedAction: 'submit'
          }
        })
      }
    );
    
    const recaptchaData = await recaptchaResponse.json();
    console.log('reCAPTCHA Enterprise result:', recaptchaData);
    
    const score = recaptchaData.riskAnalysis?.score || 0;
    const valid = recaptchaData.tokenProperties?.valid || false;
    
    // Check if reCAPTCHA validation passed
    if (!valid || score < 0.5) {
      console.error('reCAPTCHA failed:', recaptchaData);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'reCAPTCHA validation failed', details: recaptchaData })
      };
    }

    // === EMAIL VALIDATION ===
    function looksSpammyEmail(email) {
      if (!email) return false;
      
      const localPart = email.split('@')[0];
      
      // Too many dots (more than 3)
      if ((localPart.match(/\./g) || []).length > 3) {
        console.log('Email rejected: too many dots');
        return true;
      }
      
      // Multiple single-character patterns (a.b.c.d@... or longer)
      // Allow one (j.smith) but block two or more (a.b.c or longer)
      const singleCharParts = localPart.split('.').filter(part => part.length === 1);
      if (singleCharParts.length >= 2) {
        console.log('Email rejected: multiple single character patterns');
        return true;
      }
      
      // Excessive numbers in local part (more than 4 consecutive digits)
      if (/\d{5,}/.test(localPart)) {
        console.log('Email rejected: excessive numbers');
        return true;
      }
      
      return false;
    }

    // === NAME VALIDATION ===
    function looksSpammyName(name) {
      if (!name) return false;
      
      // Random case pattern - excessive mixed case in sequence (e.g., "apNOqTSDbdqnhMBcYhrKyhb")
      // Check for 4+ case changes in a row
      let caseChanges = 0;
      for (let i = 1; i < name.length; i++) {
        const prevChar = name[i - 1];
        const currChar = name[i];
        
        // Check if both are letters and case changed
        if (/[a-z]/i.test(prevChar) && /[a-z]/i.test(currChar)) {
          const prevIsUpper = prevChar === prevChar.toUpperCase();
          const currIsUpper = currChar === currChar.toUpperCase();
          if (prevIsUpper !== currIsUpper) {
            caseChanges++;
          }
        }
      }
      
      // If 4+ case changes in a name, likely spam (allows "McDonald" or "McBride" with 1-2 changes)
      if (caseChanges >= 4) {
        console.log('Name rejected: excessive case changes (random pattern)');
        return true;
      }
      
      // Random character sequences (20+ characters with very few/no vowels)
      if (name.length > 20) {
        const vowels = (name.match(/[aeiou]/gi) || []).length;
        const consonants = name.length - vowels;
        // If more than 80% consonants in a long name, likely spam
        if (consonants / name.length > 0.8) {
          console.log('Name rejected: too many consonants, looks random');
          return true;
        }
      }
      
      // Excessive repeated characters (e.g., "aaabbbccc")
      if (/(.)\1{3,}/.test(name)) {
        console.log('Name rejected: excessive repeated characters');
        return true;
      }
      
      // All lowercase with no spaces and very long (20+ chars)
      if (name.length > 20 && name === name.toLowerCase() && !name.includes(' ')) {
        console.log('Name rejected: suspiciously long lowercase string');
        return true;
      }
      
      // Excessive numbers (more than 3 digits in a name)
      if ((name.match(/\d/g) || []).length > 3) {
        console.log('Name rejected: too many numbers');
        return true;
      }
      
      return false;
    }

    // Find and validate fields
    const emailField = formData.fields?.find(f => f.name === 'email');
    const firstNameField = formData.fields?.find(f => f.name === 'firstname');
    const lastNameField = formData.fields?.find(f => f.name === 'lastname');
    const nameField = formData.fields?.find(f => f.name === 'name'); // Single name field
    
    // Check email
    if (emailField && looksSpammyEmail(emailField.value)) {
      console.error('Spammy email detected:', emailField.value);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Please provide a valid email address' })
      };
    }
    
    // Check first name (if exists)
    if (firstNameField && looksSpammyName(firstNameField.value)) {
      console.error('Spammy first name detected:', firstNameField.value);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Please provide a valid name' })
      };
    }
    
    // Check last name (if exists)
    if (lastNameField && looksSpammyName(lastNameField.value)) {
      console.error('Spammy last name detected:', lastNameField.value);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Please provide a valid name' })
      };
    }
    
    // Check single name field (if exists and first/last don't exist)
    if (nameField && looksSpammyName(nameField.value)) {
      console.error('Spammy name detected:', nameField.value);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Please provide a valid name' })
      };
    }

    // Submit to HubSpot Forms API
    const formId = formData.formId || process.env.HUBSPOT_FORM_ID;
    const hubspotUrl = `https://api.hsforms.com/submissions/v3/integration/submit/${process.env.HUBSPOT_PORTAL_ID}/${formId}`;
    console.log('Submitting to HubSpot:', hubspotUrl);
    console.log('Form data being sent:', JSON.stringify(formData));
    
    const hubspotResponse = await fetch(hubspotUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    
    const hubspotData = await hubspotResponse.json();
    console.log('HubSpot response:', hubspotData);
    
    if (!hubspotResponse.ok) {
      console.error('HubSpot error:', hubspotData);
      return {
        statusCode: hubspotResponse.status,
        body: JSON.stringify({ error: 'HubSpot submission failed', details: hubspotData })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify(hubspotData)
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
}
