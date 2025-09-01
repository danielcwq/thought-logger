function checkForUpdates() {
    var token = 'XXXXXX';
    var lastUpdateId = PropertiesService.getScriptProperties().getProperty('lastUpdateId') || 0;
    var url = 'https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (parseInt(lastUpdateId) + 1);
    
    var response = UrlFetchApp.fetch(url);
    var data = JSON.parse(response.getContentText());
    
    if (data.result.length > 0) {
      data.result.forEach(function(update) {
        if (update.message && update.message.text) {
          logTask(update.message.date, update.message.text);
          lastUpdateId = update.update_id; // Update the last processed update_id
        }
      });
      
      // Store the last update_id to ensure future calls do not process the same message
      PropertiesService.getScriptProperties().setProperty('lastUpdateId', lastUpdateId);
    } else{
      Logger.log("No new messages.")
    }
  }
  
  function logTask(timestamp, task) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var date = new Date(timestamp * 1000); // Convert timestamp to milliseconds
    var formattedDate = date.toISOString(); // Format for consistency
    
    // Check if this entry already exists
    var lastRow = sheet.getLastRow();
    var entries = lastRow > 1 ? sheet.getRange(2, 1, lastRow, 2).getValues() : [];
    
    var entryExists = entries.some(function(row) {
      return row[0] === formattedDate && row[1] === task;
    });
    
    if (!entryExists) {
      // Insert a row at the top of the main sheet
      sheet.insertRowBefore(2);
      sheet.getRange('A2:B2').setValues([[formattedDate, task]]);
    } else {
      console.log('Duplicate entry detected and skipped');
    }
  }
  