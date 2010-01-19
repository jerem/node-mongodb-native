require('mongodb/commands/query_command');
require('mongodb/commands/get_more_command');
require('mongodb/commands/kill_cursor_command');

/**
  Handles all the operations on query result using find
**/

Cursor = function(db, collection, selector, fields, skip, limit, sort, hint, explain, snapshot, timemout) {
  this.db = db;
  this.collection = collection;
  this.selector = selector;
  this.fields = fields;
  this.skip = skip;
  this.limit = limit;
  this.sortValue = sort;
  this.hint = hint;
  this.explainValue = explain;
  this.snapshot = snapshot;
  this.timemout = timemout;  
  this.numberOfReturned = 0;
  this.totalNumberOfRecords = 0;
  this.items = [];
  this.cursorId = 0;
  // Keeps track of location of the cursor
  this.index = 0
  // State variables for the cursor
  this.state = Cursor.INIT;
  // Kepp track of the current query run
  this.queryRun = false;
};

// Static variables
Cursor.INIT = 0;
Cursor.OPEN = 1;
Cursor.CLOSED = 2;

Cursor.prototype = new Object();

// Return an array of documents
Cursor.prototype.toArray = function(callback) {
  var self = this;
  
  try {
    if(self.state != Cursor.CLOSED) {
      self.fetchAllRecords(function(items) {
        self.state = Cursor.CLOSED;
        callback(items);
      });            
    } else {
      callback({ok:false, err:true, errmsg:"Cursor is closed"});
    }
  } catch(err) {
    callback(err);
  }
}

// For Each materialized the objects at need
Cursor.prototype.each = function(callback) {
  var self = this;
  
  if(this.state != Cursor.CLOSED) {
    // Fetch the next object until there is no more objects
    self.nextObject(function(item) {
      if(self.index == self.totalNumberOfRecords) {
        callback(item); 
        self.state = Cursor.CLOSED;
        callback(null);
      } else {
        callback(item);
        self.each(callback);
      }        
    });    
  } else {
    callback({ok:false, err:true, errmsg:"Cursor is closed"});    
  }
}

Cursor.prototype.count = function(callback) {
  this.collection.count(callback, this.selector);
}

Cursor.prototype.sort = function(callback, keyOrList, direction) {
  if(this.queryRun == true || this.state == Cursor.CLOSED) {
    callback({ok:false, err:true, errmsg:"Cursor is closed"});
  } else {
    var order = keyOrList;

    if(direction != null) {
      order = [[keyOrList, direction]];
    }
    this.sortValue = order;
    callback(this);
  }    
}

Cursor.prototype.generateQueryCommand = function() {
  // Unpack the options
  var timeout  = this.timeout != null ? 0 : QueryCommand.OPTS_NONE;  
  var queryOptions = timeout;
  
  // Check if we need a special selector
  if(this.sortValue != null || this.explainValue != null || this.hint != null || this.snapshot != null) {
    // Build special selector
    var specialSelector = new OrderedHash().add('query', this.selector);
    if(this.sortValue != null) specialSelector.add('orderby', this.formattedOrderClause());
    if(this.hint != null && this.hint.constructor == Object) specialSelector.add('$hint', this.hint);
    if(this.explainValue != null) specialSelector.add('$explain', true);
    if(this.snapshot != null) specialSelector.add('$snapshot', true);
    return new QueryCommand(this.db.databaseName + "." + this.collection.collectionName, queryOptions, this.skip, this.limit, specialSelector, this.fields);
  } else {
    return new QueryCommand(this.db.databaseName + "." + this.collection.collectionName, queryOptions, this.skip, this.limit, this.selector, this.fields);
  }
}

Cursor.prototype.formattedOrderClause = function() {
  var orderBy = new OrderedHash();
  var self = this;
  
  if(this.sortValue instanceof Array) {
    this.sortValue.forEach(function(sortElement) {
      if(sortElement.constructor == String) {
        orderBy.add(sortElement, 1);
      } else {
        orderBy.add(sortElement[0], self.formatSortValue(sortElement[1]));
      }    
    });
  } else if(this.sortValue instanceof OrderedHash) {
    throw new Error("Invalid sort argument was supplied");
  } else if(this.sortValue.constructor == String) {
    orderBy.add(this.sortValue, 1);
  } else {
    throw Error("Illegal sort clause, must be of the form " + 
      "[['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");
  }
  return orderBy;
}

Cursor.prototype.formatSortValue = function(sortDirection) {
  var value = ("" + sortDirection).toLowerCase();
  if(value == 'ascending' || value == 'asc' || value == 1) return 1;
  if(value == 'descending' || value == 'desc' || value == -1 ) return -1;
  throw Error("Illegal sort clause, must be of the form " + 
    "[['field1', '(ascending|descending)'], ['field2', '(ascending|descending)']]");  
}

Cursor.prototype.fetchAllRecords = function(callback) {
  var self = this;

  if(self.state == Cursor.INIT) {    
    var queryCommand = self.generateQueryCommand();
    // sys.puts("=-----------------------------------------------");
    // new BinaryParser().pprint(queryCommand.toBinary());
    self.db.executeCommand(queryCommand, function(results) {            
      var numberReturned = results[0].numberReturned;
      // Check if we need to fetch the count
      if(self.limit > 0 && self.limit > numberReturned) {
        self.totalNumberOfRecords = numberReturned;
        self.fetchFirstResults(callback, results);
      } else if(self.limit > 0 && self.limit <= numberReturned) {
        self.totalNumberOfRecords = self.limit;
        self.fetchFirstResults(callback, results);
      } else {
        self.collection.count(function(count) {
          self.totalNumberOfRecords = count;
          self.fetchFirstResults(callback, results);
        }, self.selector);
      }
    });  
  } else if(self.state == Cursor.OPEN) {
    if(self.cursorId > 0) {
      // Build get more command
      var getMoreCommand = new GetMoreCommand(self.db.databaseName + "." + self.collection.collectionName, self.limit, self.cursorId);
      // sys.puts("----------------------------------------------------");
      // new BinaryParser().pprint(getMoreCommand.toBinary());
      // Execute the command
      self.db.executeCommand(getMoreCommand, function(results) {
        results[0].documents.forEach(function(document) {
          self.items.push(document);
          self.numberOfReturned = self.numberOfReturned + 1;
        });
        // Determine if there's more documents to fetch
        if(self.numberOfReturned < self.totalNumberOfRecords) {
          self.fetchAllRecords(callback);
        } else {
          callback(self.items);
        }
      });
    } else {
      // Close the cursor as all results have been read
      self.state = Cursor.CLOSED;
    }
  }
}

Cursor.prototype.fetchFirstResults = function(callback, results) {
  var self = this;
  
  self.cursorId = results[0].cursorId;   
  self.queryRun = true;
  results[0].documents.forEach(function(document) {
    self.items.push(document);
    self.numberOfReturned = self.numberOfReturned + 1;
  });
  // Adjust the state of the cursor
  self.state = Cursor.OPEN;
  // Determine if there's more documents to fetch
  if(self.limit == 0 && self.numberOfReturned < self.totalNumberOfRecords) {
    self.fetchAllRecords(callback);
  } else {
    callback(self.items);
  }  
}

Cursor.prototype.nextObject = function(callback) {  
  var self = this;

  // Fetch the first batch of records if none are available
  if(self.state == Cursor.INIT) {   
    // Fetch the total count of object
    self.collection.count(function(count) {
      try {
        // Get total count of all objects in query
        self.totalNumberOfRecords = count;
        // Execute the first query
        self.fetchAllRecords(function(items) {
          self.items = items;

          if(self.index < items.length) {
            callback(items[self.index++]);
          } else {
            callback(null);
          }
        });        
      } catch(err) {
        callback({ok:false, err:true, errmsg:err.toString()});        
      }
    }); 
  } else {
    if(self.index < self.totalNumberOfRecords && self.items.length > self.index) {
      callback(self.items[self.index++]);
    }
  }    
}

Cursor.prototype.explain = function(callback) {
  var limit = (-1)*Math.abs(this.limit);
  // Create a new cursor and fetch the plan
  var cursor = new Cursor(this.db, this.collection, this.selector, this.fields, this.skip, limit,
      this.sortValue, this.hint, true, this.snapshot, this.timemout);
  cursor.nextObject(function(item) {
    callback(item);
    // close the cursor
    cursor.close(function(result) {
      callback(result);
    })
  });
}

Cursor.prototype.close = function(callback) {
  if(this.cursorId instanceof ObjectID) {
    var command = new KillCursorCommand([this.cursorId]);
    this.db.executeCommand(command, function(results) {
      callback(results);
    });    
  }
  
  this.cursorId = 0;
  this.state = Cursor.CLOSED;
}























